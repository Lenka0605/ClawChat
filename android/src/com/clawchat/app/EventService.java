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
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.net.Uri;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
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
    static final boolean BuildConfig_DEBUG = false; // 排查问题时临时改成 true，日志里只有事件类型和发言人，没有内容

    private volatile boolean running = false;
    // 连接代次：换电脑时加一。旧线程手上正在处理的事件，到了真正发通知那一步发现代次不对就作罢
    private static final AtomicInteger GEN = new AtomicInteger();
    private int gen;
    // 发通知统一放到主线程做，和「换电脑：作废旧代次 → 清旧通知」排在同一条队列里，不会交错
    private final Handler main = new Handler(Looper.getMainLooper());
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
            gen = GEN.get();
            worker = new Thread(this::loop, "clawchat-events");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        main.removeCallbacksAndMessages(null);
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
    private volatile String origin = "";

    private void loop() {
        long wait = 3000;
        origin = Config.origin(this);
        while (running && origin.equals(Config.origin(this)) && !origin.isEmpty()) {
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
        URL url = new URL(origin + path);
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
            if (BuildConfig_DEBUG) android.util.Log.i("ClawChat", "事件流已连上，成员 " + agentNames.size() + " 位，群 " + roomNames.size() + " 个");
            BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while (running && (line = in.readLine()) != null) {
                if (!line.startsWith("data:")) continue;
                try {
                    handle(new JSONObject(line.substring(5).trim()));
                } catch (Throwable e) {
                    // 一条事件处理不了就跳过，别让后台线程死掉（以后就再也收不到通知了）
                    if (BuildConfig_DEBUG) android.util.Log.w("ClawChat", "处理事件出错", e);
                }
            }
        } finally {
            conn = null;
            c.disconnect();
        }
    }

    private void handle(JSONObject ev) {
        String type = ev.optString("type");
        if (BuildConfig_DEBUG) android.util.Log.i("ClawChat", "事件 " + type + " 前台=" + MainActivity.visible + " 来自=" + (ev.optJSONObject("message") != null ? ev.optJSONObject("message").optString("from") : "-"));
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
        // 默认只说「有新回复」，内容预览要在 App 设置里自己打开；出错的提示不带内容
        String body = agent ? Config.L("有新回复", "New reply") : Config.L("出错了，点开看看", "Something went wrong — tap to see");
        if (agent && Config.preview(this)) {
            try {
                String p = plain(text);
                if (!p.isEmpty()) body = p;
            } catch (Throwable ignored) {} // 整理内容出了任何问题：照样提醒，只是不带预览
        }
        notifyReply(conv, title, body);
    }

    // 换电脑：先作废旧代次（旧线程之后再想发通知都会作罢），再清掉旧电脑发来的通知、撤销它们的点击凭据（常驻那条「已连接」不动）。
    // 必须在主线程调用，和发通知排在同一条队列里
    static void switchComputer(Context c) {
        GEN.incrementAndGet();
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        for (android.service.notification.StatusBarNotification n : nm.getActiveNotifications()) {
            if (n.getId() == ONGOING_ID) continue;
            PendingIntent pi = n.getNotification().contentIntent;
            if (pi != null) pi.cancel();
            nm.cancel(n.getId());
        }
    }

    // 点通知打开哪个聊天：电脑地址和聊天编号都放进 Intent 的 data 里（data 参与凭据的身份区分，extras 不参与），
    // 两台电脑有同一个聊天编号也是两份不同的凭据，不会互相覆盖
    static final String OPEN_SCHEME = "clawchat-notify";

    static Uri openUri(String origin, String conv) {
        return new Uri.Builder().scheme(OPEN_SCHEME).authority("open").appendQueryParameter("origin", origin).appendQueryParameter("conv", conv).build();
    }

    private void notifyReply(String conv, String title, String body) {
        final String from = origin;
        final int myGen = gen;
        main.post(() -> {
            // 到主线程这一刻再核对：服务没停、没换过电脑、地址还是这台
            if (!running || myGen != GEN.get() || !from.equals(Config.origin(this))) return;
            post(from, conv, title, body);
        });
    }

    private void post(String from, String conv, String title, String body) {
        String key = from + "\n" + conv;
        int id = key.hashCode() == ONGOING_ID ? ONGOING_ID + 1 : key.hashCode();
        Intent open = new Intent(this, MainActivity.class).setData(openUri(from, conv)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CH_REPLY)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build();
        getSystemService(NotificationManager.class).notify(id, n); // 同一个聊天只留最新一条
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
