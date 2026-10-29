package demo;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * 本番用の入口。JavaScript（ページ側の CheerpJ）から static メソッドとして呼ぶ。
 * どちらのメソッドも例外を投げず、結果を JSON 文字列で返す。
 *
 *   start()     Spring Boot + Spring MVC を起動する（2回目以降は何もしない）
 *               → {"ok":true,"ms":1234} / {"ok":false,"ms":1234,"error":"…"}
 *   dispatch()  HTTP リクエスト1件を DispatcherServlet に流す
 *               → {"status":200,"headers":{"Content-Type":"…"},"body":"…"}
 *
 * 起動の仕組み（何もしない WebServer と MockServletContext）は Probe と共通。
 */
public class Bridge {

    private static final ObjectMapper JSON = new ObjectMapper();

    public static String start() {
        long t = System.currentTimeMillis();
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            Probe.ensureWeb();
            out.put("ok", true);
        } catch (Throwable e) {
            out.put("ok", false);
            out.put("error", trace(e));
        }
        out.put("ms", System.currentTimeMillis() - t);
        return write(out);
    }

    public static String dispatch(String method, String pathWithQuery, String body) {
        int status;
        Map<String, String> headers = new LinkedHashMap<>();
        String content;
        try {
            Probe.ensureWeb();
            MockHttpServletResponse res = new MockHttpServletResponse();
            Probe.dispatcher().service(request(method, pathWithQuery, body), res);
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
            error.put("trace", trace(e));
            content = write(error);
        }
        headers.put("X-Served-By", "spring-boot (CheerpJ)");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", status);
        out.put("headers", headers);
        out.put("body", content);
        return write(out);
    }

    /** "/api/todos?done=true&q=..." を、パスとクエリ（パラメータ）に分けて MockHttpServletRequest にする */
    static MockHttpServletRequest request(String method, String pathWithQuery, String body) {
        int q = pathWithQuery.indexOf('?');
        String path = q < 0 ? pathWithQuery : pathWithQuery.substring(0, q);
        String query = q < 0 ? null : pathWithQuery.substring(q + 1);

        MockHttpServletRequest req = new MockHttpServletRequest(Probe.servletContext(), method.toUpperCase(), path);
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
            req.setContentType("application/json");
            req.setCharacterEncoding("UTF-8");
            req.setContent(body.getBytes(StandardCharsets.UTF_8));
        }
        return req;
    }

    private static String trace(Throwable e) {
        StringWriter sw = new StringWriter();
        e.printStackTrace(new PrintWriter(sw));
        String s = sw.toString();
        return s.length() > 4000 ? s.substring(0, 4000) + "\n...(truncated)" : s;
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
