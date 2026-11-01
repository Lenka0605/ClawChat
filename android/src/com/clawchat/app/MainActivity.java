package com.clawchat.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.content.res.AssetFileDescriptor;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

// 主界面：第一次打开先填家里电脑的地址（https://xxx.ts.net），之后就是全屏的 ClawChat 网页。
// 安全上的几条（老板要求「要确保安全」）：
// - 只加载这一个地址（协议、主机、端口都要对上），别的网址一律交给手机浏览器打开，不在 App 里打开
// - 证书不对直接拒绝，不给「继续访问」的选项；不允许 http
// - 不给网页开任何调用手机功能的口子（没有 addJavascriptInterface），不能读手机上的文件，不能弹新窗口
// - 选图片走系统的选择器，只给网页用户亲手选的那几张
public class MainActivity extends Activity {
    static volatile boolean visible = false; // 在前台时不弹通知（正看着呢）

    private static final int PICK_FILES = 1;
    private static final int ASK_NOTIFY = 2;

    private WebView web;
    private FrameLayout root;
    private ValueCallback<Uri[]> pendingFiles;
    private String pendingConv;

    private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());
    // 网页开着时每隔几秒看一眼它的底色，状态栏、导航栏跟着换（老板在设置里切深浅色时也跟得上）
    private final Runnable syncBars = new Runnable() {
        @Override
        public void run() {
            if (web != null && visible) {
                web.evaluateJavascript("getComputedStyle(document.body).backgroundColor", v -> paintBars(parseRgb(v)));
                ui.postDelayed(this, 3000);
            }
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        // 填地址那一页按系统深浅色选主题，字不会发灰
        setTheme(nightMode() ? android.R.style.Theme_DeviceDefault_NoActionBar : android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(false);
        root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        setContentView(root);
        paintBars(null);
        pendingConv = convOf(getIntent());
        if (Config.origin(this).isEmpty()) showSetup(null);
        else showWeb();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String conv = convOf(intent);
        if (conv == null) return;
        if (web != null) openConv(conv);
        else pendingConv = conv;
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        if (web != null) web.onResume();
        ui.removeCallbacks(syncBars);
        ui.post(syncBars);
    }

    @Override
    protected void onPause() {
        visible = false;
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        if (web == null) paintBars(null); // 填地址那一页跟着系统深浅色；网页开着时由 syncBars 跟网页底色
    }

    private boolean nightMode() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    // 网页返回的 "rgb(30, 30, 30)" / "\"rgba(…)\""：认不出来就返回 null
    private static Integer parseRgb(String v) {
        if (v == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)").matcher(v);
        if (!m.find()) return null;
        return Color.rgb(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
    }

    // 状态栏、导航栏的颜色：网页开着时跟网页底色一致，否则跟着系统深浅色
    private void paintBars(Integer color) {
        int bg = color != null ? color : nightMode() ? Color.rgb(30, 30, 30) : Color.rgb(245, 245, 247);
        boolean dark = (Color.red(bg) * 299 + Color.green(bg) * 587 + Color.blue(bg) * 114) / 1000 < 128;
        Window w = getWindow();
        w.setStatusBarColor(bg);
        w.setNavigationBarColor(bg);
        root.setBackgroundColor(bg);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : light, light);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
    }

    // 从通知点进来要打开哪个聊天：通知是别的电脑（换地址以前）发的，就不跳
    private String convOf(Intent i) {
        Uri d = i == null ? null : i.getData();
        if (d == null || !EventService.OPEN_SCHEME.equals(d.getScheme())) return null;
        String conv = d.getQueryParameter("conv");
        return conv != null && Config.origin(this).equals(d.getQueryParameter("origin")) ? conv : null;
    }

    // ---------------- 第一次打开：填地址 ----------------

    private void showSetup(String error) {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        root.removeAllViews();
        int pad = dp(24);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad, pad, pad);
        box.setGravity(Gravity.CENTER_VERTICAL);

        TextView title = new TextView(this);
        title.setText(Config.L("连接到你的电脑", "Connect to your computer"));
        title.setTextSize(22);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText(Config.L(
            "在电脑上打开 ClawChat，进「设置 → 通用 → 手机访问」，把那里的访问地址填进来（https://…ts.net）。\n手机上要先装好 Tailscale，并登录和电脑同一个账号。",
            "On your computer, open ClawChat → Settings → General → Phone access and enter the address shown there (https://…ts.net).\nInstall Tailscale on this phone and sign in with the same account as your computer."));
        hint.setTextSize(14);
        hint.setPadding(0, dp(10), 0, dp(16));
        box.addView(hint);

        EditText input = new EditText(this);
        input.setHint("https://your-mac.xxxx.ts.net");
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(Config.origin(this));
        box.addView(input);

        CheckBox notify = new CheckBox(this);
        notify.setText(Config.L("AI 回复时发通知（后台保持连接）", "Notify me when AI replies (keeps a background connection)"));
        notify.setChecked(Config.notify(this));
        notify.setPadding(0, dp(8), 0, dp(8));
        box.addView(notify);

        CheckBox preview = new CheckBox(this);
        preview.setText(Config.L("通知里显示回复内容（锁屏上旁人也看得到）", "Show reply text in notifications (visible on the lock screen)"));
        preview.setChecked(Config.preview(this));
        preview.setPadding(0, 0, 0, dp(8));
        box.addView(preview);

        TextView err = new TextView(this);
        err.setTextColor(Color.rgb(255, 69, 58));
        err.setText(error == null ? "" : error);
        box.addView(err);

        Button go = new Button(this);
        go.setText(Config.L("连接", "Connect"));
        go.setOnClickListener(v -> {
            String origin = Config.normalize(input.getText().toString());
            if (origin == null) {
                err.setText(Config.L("地址不对：要填电脑上「手机访问」里显示的 https://…ts.net 地址", "That doesn't look right: enter the https://…ts.net address shown under Phone access"));
                return;
            }
            // 换了电脑：先断开旧电脑的后台连接、清掉旧通知，再连新的（不然旧连接还在、旧通知点开会进到新电脑上）
            if (!origin.equals(Config.origin(this))) {
                stopService(new Intent(this, EventService.class));
                EventService.switchComputer(this);
            }
            Config.setOrigin(this, origin);
            Config.setNotify(this, notify.isChecked());
            Config.setPreview(this, preview.isChecked());
            showWeb();
        });
        box.addView(go);
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // ---------------- 网页 ----------------

    private void showWeb() {
        root.removeAllViews();
        String origin = Config.origin(this);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 草稿、展开状态这些存在 localStorage 里
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " ClawChatAndroid/1.0");
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (Config.sameOrigin(origin, u)) return false;
                // 网页里的「App 设置」：回到填地址那一页（换地址、开关通知）。只是跳页面，不给网页任何别的能力
                if ("clawchat".equalsIgnoreCase(u.getScheme()) && "settings".equalsIgnoreCase(u.getHost())) {
                    showSetup(null);
                    return true;
                }
                openOutside(u); // 别的网址交给手机浏览器
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); // 证书不对：一律拒绝
                showSetup(Config.L("证书不对，已经拒绝连接。请确认地址是电脑上显示的那个。", "The certificate is invalid, so the connection was refused. Check the address."));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                if (!req.isForMainFrame()) return;
                showSetup(Config.L(
                    "连不上电脑。请检查：手机上的 Tailscale 开着、登录的是同一个账号；电脑开着、没睡；ClawChat 里「手机访问」开着。",
                    "Can't reach your computer. Check that Tailscale is on (same account), the computer is awake, and Phone access is on in ClawChat."));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                ui.removeCallbacks(syncBars);
                ui.post(syncBars);
                if (pendingConv != null) {
                    openConv(pendingConv);
                    pendingConv = null;
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // 网页里点「图片」：用系统的选择器，只把用户选中的那几张交给网页
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                boolean multi = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                Intent pick;
                if (Build.VERSION.SDK_INT >= 33) {
                    // 安卓 13 起用系统自带的照片选择器：别的 App 没法冒充
                    pick = new Intent(MediaStore.ACTION_PICK_IMAGES);
                    if (multi) pick.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, Math.min(20, MediaStore.getPickImagesMaxLimit()));
                } else {
                    Intent get = new Intent(Intent.ACTION_GET_CONTENT);
                    get.addCategory(Intent.CATEGORY_OPENABLE);
                    get.setType("image/*");
                    get.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multi);
                    pick = Intent.createChooser(get, Config.L("选择图片", "Choose images"));
                }
                try {
                    startActivityForResult(pick, PICK_FILES);
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(origin + "/");
        startNotifications();
    }

    // 从通知点进来：网页已经开着就直接切到那个聊天，没开好就等加载完
    private void openConv(String conv) {
        if (web == null) return;
        String key = JSONObject.quote(conv);
        web.evaluateJavascript("typeof openConv === 'function' && openConv(" + key + ")", null);
    }

    private void openOutside(Uri u) {
        String scheme = u.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme) && !"mailto".equalsIgnoreCase(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {}
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != PICK_FILES || pendingFiles == null) {
            super.onActivityResult(request, result, data);
            return;
        }
        java.util.List<Uri> picked = new java.util.ArrayList<>();
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) picked.add(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) {
                picked.add(data.getData());
            }
        }
        // 只收别的 App 提供的 content:// 文件（相册、文件管理器）；file:// 和指向本 App 自己的一律不要，
        // 免得被不怀好意的选择器塞进本 App 的私有文件（Android 官方要求检查选择器的返回结果）
        java.util.List<Uri> ok = new java.util.ArrayList<>();
        for (Uri u : picked) if (safePick(u, data)) ok.add(u);
        pendingFiles.onReceiveValue(ok.isEmpty() ? null : ok.toArray(new Uri[0]));
        pendingFiles = null;
    }

    // 选择器交回来的每一张都要过五关，任何一关不过就丢掉：
    // 1. 只要 content://，地址里不能带「用户编号@」；
    // 2. 按地址找到真正提供这个文件的 App（看系统登记的提供者，不看名字像不像），是本 App 自己的不要；
    // 3. 选择器这次明确给了读授权，系统也确认本 App 现在读得了；
    // 4. 系统报的类型是图片；
    // 5. 真的打得开。
    private boolean safePick(Uri u, Intent data) {
        try {
            if (u == null || !"content".equals(u.getScheme())) return false;
            String auth = u.getAuthority();
            if (auth == null || auth.isEmpty() || auth.contains("@")) return false;
            ProviderInfo p = getPackageManager().resolveContentProvider(auth, 0);
            if (p == null || p.applicationInfo == null) return false;
            if (p.applicationInfo.uid == Process.myUid() || getPackageName().equals(p.packageName)) return false;
            if ((data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) return false;
            if (checkUriPermission(u, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) return false;
            String type = getContentResolver().getType(u);
            if (type == null || !type.startsWith("image/")) return false;
            try (AssetFileDescriptor fd = getContentResolver().openAssetFileDescriptor(u, "r")) {
                return fd != null;
            }
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    protected void onDestroy() {
        // 页面没了：还在等的选图回调交回空，别留着
        if (pendingFiles != null) {
            pendingFiles.onReceiveValue(null);
            pendingFiles = null;
        }
        super.onDestroy();
    }

    // 手机的返回键：网页里能退（比如从聊天退回列表）就先退，退到头了才退出 App
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // 后台通知：在填地址那一页可以关掉；关掉就停掉后台连接
    private void startNotifications() {
        if (!Config.notify(this)) {
            stopService(new Intent(this, EventService.class));
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, ASK_NOTIFY);
            return;
        }
        EventService.start(this);
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] perms, int[] grants) {
        if (request != ASK_NOTIFY) return;
        if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) EventService.start(this);
        else {
            Config.setNotify(this, false);
            new AlertDialog.Builder(this)
                .setMessage(Config.L("没有通知权限，AI 回复时不会提醒你。以后想要的话，在系统设置里给 ClawChat 打开通知，再重新连接一次。", "Notifications are off. To enable them later, allow notifications for ClawChat in system settings and reconnect."))
                .setPositiveButton(android.R.string.ok, null)
                .show();
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
