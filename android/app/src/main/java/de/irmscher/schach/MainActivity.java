package de.irmscher.schach;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Locale;

/**
 * Hülle für Justins Schach-App: zeigt die Web-App vom eigenen Server.
 * Updates der App kommen über den Server, die APK muss dafür nicht neu installiert werden.
 */
public class MainActivity extends Activity {

    private WebView web;
    private TextToSpeech tts;
    private boolean ttsBereit = false;

    private static final String OFFLINE =
            "<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<style>body{font-family:sans-serif;background:#f3f4f1;color:#1d2420;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px;text-align:center}"
            + "@media(prefers-color-scheme:dark){body{background:#141917;color:#e7ece8}}"
            + "button{font:600 16px sans-serif;background:#2f6b4f;color:#fff;border:0;border-radius:8px;padding:12px 18px;margin-top:16px}</style></head>"
            + "<body><div><h2>Keine Verbindung</h2><p>Die Schach-App braucht beim ersten Start Internet.</p>"
            + "<button onclick=\"location.replace('%s')\">Nochmal versuchen</button></div></body></html>";

    @Override
    protected void onCreate(Bundle zustand) {
        super.onCreate(zustand);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " SchachApp/" + BuildConfig.VERSION_NAME);

        final String start = BuildConfig.APP_URL;
        final String host = Uri.parse(start).getHost();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (host != null && host.equalsIgnoreCase(u.getHost())) return false;
                // Links nach außen (Lichess, Claude, chess.com) im passenden Programm öffnen
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception e) {
                    // nichts installiert, das den Link öffnen kann
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) {
                    v.loadDataWithBaseURL(start, String.format(OFFLINE, start), "text/html", "utf-8", null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bruecke(), "SchachNative");

        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.GERMAN);
                ttsBereit = true;
            }
        });

        if (zustand != null) web.restoreState(zustand);
        else web.loadUrl(start);
    }

    /** Vorlesen über die Sprachausgabe des Handys, aufgerufen aus der Web-App. */
    private class Bruecke {
        @JavascriptInterface
        public void sprich(String text) {
            if (ttsBereit && text != null) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "schach");
        }

        @JavascriptInterface
        public void stopp() {
            if (ttsBereit) tts.stop();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle aus) {
        super.onSaveInstanceState(aus);
        web.saveState(aus);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
