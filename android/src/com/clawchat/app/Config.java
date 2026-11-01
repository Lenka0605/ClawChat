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

    static String origin(Context c) {
        return prefs(c).getString("origin", "");
    }

    static void setOrigin(Context c, String origin) {
        prefs(c).edit().putString("origin", origin).apply();
    }

    static boolean notify(Context c) {
        return prefs(c).getBoolean("notify", true);
    }

    static void setNotify(Context c, boolean on) {
        prefs(c).edit().putBoolean("notify", on).apply();
    }

    // 只接受 Tailscale 的 https 地址（xxx.ts.net）：别的网址一律不认，免得被引到别的网站去
    static String normalize(String input) {
        if (input == null) return null;
        String s = input.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "https://" + s;
        Uri u = Uri.parse(s);
        String host = u.getHost();
        if (!"https".equalsIgnoreCase(u.getScheme()) || host == null) return null;
        host = host.toLowerCase(Locale.ROOT);
        if (!host.endsWith(".ts.net") || host.length() <= ".ts.net".length()) return null;
        if (u.getUserInfo() != null) return null;
        int port = u.getPort();
        return "https://" + host + (port > 0 && port != 443 ? ":" + port : "");
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
