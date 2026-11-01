package com.clawchat.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

// 在后台连着家里的电脑（和网页一样听 /api/events），AI 回复、出错时弹手机通知；App 在前台时不弹（正看着呢）。
// 只连填进来的那个 https://xxx.ts.net 地址，走系统的证书校验（不认的证书直接失败）；只读事件，不往电脑发任何东西。
// 安卓要求后台一直连着的服务必须挂一条常驻通知，那条通知上有「断开」
public class EventService extends Service {
    private static final String CH_CONN = "connection";
    private static final String CH_REPLY = "replies";
    private static final int ONGOING_ID = 1;
    private static final String ACTION_STOP = "com.clawchat.app.STOP";

    private volatile boolean running = false;
    private Thread worker;
    private HttpsURLConnection conn;
    private final Map<String, String> roomNames = new HashMap<>();
    private final Map<String, Integer> roomSizes = new HashMap<>();
    private final Map<String, String> agentNames = new HashMap<>();

    static void start(Context c) {
        Intent i = new Intent(c, EventService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            Config.setNotify(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        channels();
        Notification ongoing = ongoing();
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ONGOING_ID, ongoing);
        if (Config.origin(this).isEmpty() || !Config.notify(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            worker = new Thread(this::loop, "clawchat-events");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpsURLConnection c = conn;
        if (c != null) c.disconnect();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    private void channels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel conn = new NotificationChannel(CH_CONN, Config.L("后台连接", "Background connection"), NotificationManager.IMPORTANCE_MIN);
        conn.setShowBadge(false);
        nm.createNotificationChannel(conn);
        nm.createNotificationChannel(new NotificationChannel(CH_REPLY, Config.L("AI 回复", "AI replies"), NotificationManager.IMPORTANCE_HIGH));
    }

    private Notification ongoing() {
        Intent stop = new Intent(this, EventService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CH_CONN)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(Config.L("ClawChat 已连接", "ClawChat connected"))
            .setContentText(Config.L("AI 回复时会通知你", "You'll be notified when AI replies"))
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, Config.L("断开", "Disconnect"), stopPi).build())
            .setOngoing(true)
            .build();
    }

    // 断了就重连：3 秒起，每次翻倍，最多等 1 分钟
    private void loop() {
        long wait = 3000;
        while (running) {
            try {
                loadState();
                listen();
                wait = 3000;
            } catch (Exception e) {
                android.util.Log.w("ClawChat", "后台连接断了：" + e.getClass().getSimpleName()); // 只记错误类型，不记地址和内容
            }
            if (!running) break;
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                break;
            }
            wait = Math.min(wait * 2, 60000);
        }
    }

    private HttpsURLConnection open(String path, int readTimeout) throws Exception {
        URL url = new URL(Config.origin(this) + path);
        if (!"https".equals(url.getProtocol())) throw new IllegalStateException("only https");
        HttpsURLConnection c = (HttpsURLConnection) url.openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(readTimeout);
        c.setInstanceFollowRedirects(false); // 不跟着跳到别的地方
        c.setRequestProperty("User-Agent", "ClawChatAndroid/1.0");
        return c;
    }

    // 群名、成员名：通知标题要用
    private void loadState() throws Exception {
        HttpsURLConnection c = open("/api/state", 20000);
        try {
            if (c.getResponseCode() != 200) throw new IllegalStateException("state " + c.getResponseCode());
            JSONObject st = new JSONObject(read(c.getInputStream(), 20 * 1024 * 1024));
            applyRooms(st.optJSONArray("rooms"));
            JSONObject agents = st.optJSONObject("agents");
            if (agents != null) {
                JSONArray ids = agents.names();
                for (int i = 0; ids != null && i < ids.length(); i++) {
                    String id = ids.getString(i);
                    JSONObject a = agents.optJSONObject(id);
                    agentNames.put(id, a != null ? a.optString("name", id) : id);
                }
            }
        } finally {
            c.disconnect();
        }
    }

    private void applyRooms(JSONArray rooms) {
        if (rooms == null) return;
        for (int i = 0; i < rooms.length(); i++) {
            JSONObject r = rooms.optJSONObject(i);
            if (r == null) continue;
            roomNames.put(r.optString("id"), r.optString("name"));
            JSONArray m = r.optJSONArray("members");
            roomSizes.put(r.optString("id"), m == null ? 0 : m.length());
        }
    }

    // 听电脑推过来的事件（服务端每 25 秒发一次心跳，超过 70 秒没动静就当断了重连）
    private void listen() throws Exception {
        HttpsURLConnection c = open("/api/events", 70000);
        conn = c;
        try {
            if (c.getResponseCode() != 200) throw new IllegalStateException("events " + c.getResponseCode());
            BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while (running && (line = in.readLine()) != null) {
                if (!line.startsWith("data:")) continue;
                try {
                    handle(new JSONObject(line.substring(5).trim()));
                } catch (Exception ignored) {}
            }
        } finally {
            conn = null;
            c.disconnect();
        }
    }

    private void handle(JSONObject ev) {
        String type = ev.optString("type");
        if ("rooms".equals(type)) {
            applyRooms(ev.optJSONArray("rooms"));
            return;
        }
        if (!"message".equals(type) || MainActivity.visible) return;
        JSONObject m = ev.optJSONObject("message");
        String roomId = ev.optString("roomId");
        if (m == null || roomId.isEmpty()) return;
        String from = m.optString("from");
        String text = m.optString("text", "");
        boolean agent = agentNames.containsKey(from);
        boolean error = "system".equals(from) && (text.contains("出错") || text.toLowerCase().contains("error"));
        if (!agent && !error) return; // 老板自己发的、普通的系统提示：不提醒
        String dm = m.optString("dm", "");
        String pm = m.optString("pm", "");
        String conv = !dm.isEmpty() ? "d:" + roomId + ":" + dm : !pm.isEmpty() ? "d:" + roomId + ":" + m.optString("pmIn", pm) : "g:" + roomId;
        String room = roomNames.containsKey(roomId) ? roomNames.get(roomId) : "ClawChat";
        boolean solo = roomSizes.containsKey(roomId) && roomSizes.get(roomId) == 1;
        String name = agent ? agentNames.get(from) : "ClawChat";
        String title;
        if (!pm.isEmpty()) title = name + " → " + (agentNames.containsKey(pm) ? agentNames.get(pm) : pm) + " · " + room;
        else if (!dm.isEmpty() && !solo) title = Config.L(name + "（私聊）", name + " (private)");
        else if (solo) title = name;
        else title = name + " · " + room;
        notifyReply(conv, title, plain(text));
    }

    private void notifyReply(String conv, String title, String body) {
        Intent open = new Intent(this, MainActivity.class).putExtra("conv", conv).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, conv.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CH_REPLY)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build();
        getSystemService(NotificationManager.class).notify(conv.hashCode(), n); // 同一个聊天只留最新一条
    }

    // 通知里只放纯文字：去掉 Markdown 记号、私聊标签，太长就截断
    private static String plain(String s) {
        String t = s.replaceAll("```[\\s\\S]*?```", " ")
            .replaceAll("[`*_>#]", "")
            .replaceAll("\\[([^\\]]*)\\]\\([^)]*\\)", "$1")
            .replaceAll("\\s+", " ")
            .trim();
        return t.length() > 300 ? t.substring(0, 300) + "…" : t;
    }

    private static String read(InputStream in, int max) throws Exception {
        byte[] buf = new byte[8192];
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) throw new IllegalStateException("too big");
        }
        return out.toString("UTF-8");
    }
}
