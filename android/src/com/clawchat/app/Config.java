package com.clawchat.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.Locale;

// 记住家里那台电脑的地址（只记 https://xxx.ts.net 这样的源，不带路径），以及要不要在后台收通知
final class Config {
    private static final String PREFS = "clawchat";

    private Config() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // 存着的地址每次用之前都重新校验一遍：不合规（比如旧版本存进去的、被改过的）就当没填
    static String origin(Context c) {
        String o = prefs(c).getString("origin", "");
        return o.equals(normalize(o)) ? o : "";
    }

    static void setOrigin(Context c, String origin) {
        prefs(c).edit().putString("origin", origin).apply();
    }

    // 通知里要不要带回复内容的预览：默认不带（只写「有新回复」），免得锁屏、通知栏被旁人看到私聊内容
    static boolean preview(Context c) {
        return prefs(c).getBoolean("preview", false);
    }

    static void setPreview(Context c, boolean on) {
        prefs(c).edit().putBoolean("preview", on).apply();
    }

    static boolean notify(Context c) {
        return prefs(c).getBoolean("notify", true);
    }

    static void setNotify(Context c, boolean on) {
        prefs(c).edit().putBoolean("notify", on).apply();
    }

    // 只接受 Tailscale 的 https 地址（名字.ts.net，可以带端口），整串严格按格式匹配：
    // 百分号编码、路径、问号、#、@ 这些一概不认（以前用解析器拆主机名，%2f 这种写法能把主机名拼成别的网站，ChatGPT 复核时查出来的）
    private static final java.util.regex.Pattern ORIGIN =
        java.util.regex.Pattern.compile("^(?:https://)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+ts\\.net)(?::(\\d{1,5}))?/?$");

    static String normalize(String input) {
        if (input == null) return null;
        String s = input.trim().toLowerCase(Locale.ROOT);
        java.util.regex.Matcher m = ORIGIN.matcher(s);
        if (!m.matches()) return null;
        String host = m.group(1);
        int port = m.group(2) == null ? 443 : Integer.parseInt(m.group(2));
        if (port < 1 || port > 65535) return null;
        return "https://" + host + (port != 443 ? ":" + port : "");
    }

    // 这个网址是不是家里那台电脑（协议、主机、端口都要一样）
    static boolean sameOrigin(String origin, Uri u) {
        if (origin.isEmpty() || u == null || u.getHost() == null) return false;
        String port = u.getPort() > 0 && u.getPort() != 443 ? ":" + u.getPort() : "";
        return origin.equals("https://" + u.getHost().toLowerCase(Locale.ROOT) + port) && "https".equalsIgnoreCase(u.getScheme());
    }

    static boolean zh() {
        return Locale.getDefault().getLanguage().startsWith("zh");
    }

    static String L(String zh, String en) {
        return zh() ? zh : en;
    }
}
