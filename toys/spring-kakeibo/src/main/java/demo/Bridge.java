package demo;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.servlet.ServletContext;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import demo.kakeibo.KakeiboApp;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockServletConfig;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.DispatcherServlet;

/**
 * 本番用の入口（spring-sw-bridge と同じ）。JavaScript（ページ側の CheerpJ）から static メソッドとして呼ぶ。
 * どちらのメソッドも例外を投げず、結果を JSON 文字列で返す。
 *
 *   start()     家計簿アプリ（Spring Boot + MVC + JPA + H2）を起動し、保存してある DB を戻す
 *               → {"ok":true,"ms":1234} / {"ok":false,"ms":1234,"error":"…"}
 *   dispatch()  HTTP リクエスト1件を DispatcherServlet に流す
 *               → {"status":200,"headers":{"Content-Type":"…"},"body":"…"}
 */
public class Bridge {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static ConfigurableApplicationContext context;
    private static ServletContext servletContext;
    private static DispatcherServlet dispatcher;

    private static synchronized void ensureStarted() throws Exception {
        if (dispatcher != null) {
            return;
        }
        context = KakeiboApp.start(Map.of());
        servletContext = ((WebApplicationContext) context).getServletContext();
        DispatcherServlet servlet = context.getBean(DispatcherServlet.class);
        servlet.init(new MockServletConfig(servletContext));
        dispatcher = servlet;
    }

    public static String start() {
        long t = System.currentTimeMillis();
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            ensureStarted();
            out.put("ok", true);
        } catch (Throwable e) {
            out.put("ok", false);
            out.put("error", Probe.trace(e));
        }
        out.put("ms", System.currentTimeMillis() - t);
        return write(out);
    }

    public static String dispatch(String method, String pathWithQuery, String body) {
        int status;
        Map<String, String> headers = new LinkedHashMap<>();
        String content;
        try {
            ensureStarted();
            MockHttpServletResponse res = new MockHttpServletResponse();
            dispatcher.service(request(method, pathWithQuery, body), res);
            status = res.getStatus();
            for (String name : res.getHeaderNames()) {
                headers.put(name, String.join(", ", res.getHeaders(name)));
            }
            if (res.getContentType() != null) {
                headers.putIfAbsent("Content-Type", res.getContentType());
            }
            content = res.getContentAsString(StandardCharsets.UTF_8);
        } catch (Throwable e) {
            // 握りつぶさず、500 と例外の内容をそのまま返す
            status = 500;
            headers.clear();
            headers.put("Content-Type", "application/json");
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("error", "internal_error");
            error.put("message", String.valueOf(e));
            error.put("trace", Probe.trace(e));
            content = write(error);
        }
        headers.put("X-Served-By", "spring-boot (CheerpJ)");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", status);
        out.put("headers", headers);
        out.put("body", content);
        return write(out);
    }

    /** "/api/transactions?from=...&q=..." を、パスとクエリ（パラメータ）に分けて MockHttpServletRequest にする */
    static MockHttpServletRequest request(String method, String pathWithQuery, String body) {
        int q = pathWithQuery.indexOf('?');
        String path = q < 0 ? pathWithQuery : pathWithQuery.substring(0, q);
        String query = q < 0 ? null : pathWithQuery.substring(q + 1);

        MockHttpServletRequest req = new MockHttpServletRequest(servletContext, method.toUpperCase(), path);
        if (query != null && !query.isEmpty()) {
            req.setQueryString(query);
            for (String pair : query.split("&")) {
                if (pair.isEmpty()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                String name = eq < 0 ? pair : pair.substring(0, eq);
                String value = eq < 0 ? "" : pair.substring(eq + 1);
                req.addParameter(URLDecoder.decode(name, StandardCharsets.UTF_8),
                        URLDecoder.decode(value, StandardCharsets.UTF_8));
            }
        }
        if (body != null && !body.isEmpty()) {
            // 本文は JSON・CSV・SQL のどれでも、コントローラは文字列として受け取る
            req.setContentType("text/plain");
            req.setCharacterEncoding("UTF-8");
            req.setContent(body.getBytes(StandardCharsets.UTF_8));
        }
        return req;
    }

    private static String write(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            // Map と文字列だけなので通常は起きない。起きたら最低限の JSON を返す
            return "{\"status\":500,\"headers\":{},\"body\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        }
    }
}
