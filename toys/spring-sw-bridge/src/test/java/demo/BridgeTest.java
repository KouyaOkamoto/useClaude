package demo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Bridge.dispatch が toys/browser-rest-api と同じ API 仕様になっているかを確かめる。
 * テストの中身は browser-rest-api/test/api.test.mjs をそのまま移したもの。
 */
class BridgeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** dispatch の戻り値を読みやすくしたもの */
    static final class Res {
        int status;
        Map<String, String> headers;
        Object json;

        String header(String name) {
            return headers.entrySet().stream()
                    .filter(e -> e.getKey().equalsIgnoreCase(name))
                    .map(Map.Entry::getValue).findFirst().orElse(null);
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> map() {
            return (Map<String, Object>) json;
        }

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list() {
            return (List<Map<String, Object>>) json;
        }
    }

    @SuppressWarnings("unchecked")
    static Res call(String method, String path, Object body) throws Exception {
        String raw = body == null ? "" : body instanceof String ? (String) body : JSON.writeValueAsString(body);
        Map<String, Object> out = JSON.readValue(Bridge.dispatch(method, "/api/" + path, raw), Map.class);
        Res res = new Res();
        res.status = (Integer) out.get("status");
        res.headers = (Map<String, String>) out.get("headers");
        String text = (String) out.get("body");
        res.json = text.isEmpty() ? null : JSON.readValue(text, Object.class);
        return res;
    }

    static Res call(String method, String path) throws Exception {
        return call(method, path, null);
    }

    static List<Object> ids(Res res) {
        return res.list().stream().map(t -> t.get("id")).collect(Collectors.toList());
    }

    @BeforeAll
    static void boot() {
        assertTrue(Bridge.start().contains("\"ok\":true"));
    }

    @BeforeEach
    void empty() {
        Probe.webContext().getBean(TodoController.class).clear();
    }

    @Test
    void healthAndIndex() throws Exception {
        Res h = call("GET", "health");
        assertEquals(200, h.status);
        assertEquals("spring-boot", h.map().get("runtime"));
        assertEquals("spring-boot (CheerpJ)", h.header("X-Served-By"));
        Res root = call("GET", "");
        assertEquals(200, root.status);
        assertTrue(((List<?>) root.map().get("endpoints")).size() > 0);
    }

    @Test
    void crudFlow() throws Exception {
        assertEquals(List.of(), call("GET", "todos").json);

        Res created = call("POST", "todos", Map.of("title", "  牛乳を買う  "));
        assertEquals(201, created.status);
        assertEquals(1, created.map().get("id"));
        assertEquals("牛乳を買う", created.map().get("title"));
        assertEquals(false, created.map().get("done"));
        assertEquals("/api/todos/1", created.header("Location"));
        assertTrue(created.header("Content-Type").startsWith("application/json"));

        assertEquals("牛乳を買う", call("GET", "todos/1").map().get("title"));

        Res patched = call("PATCH", "todos/1", Map.of("done", true));
        assertEquals(200, patched.status);
        assertEquals(true, patched.map().get("done"));
        assertEquals("牛乳を買う", patched.map().get("title"));

        Res put = call("PUT", "todos/1", Map.of("title", "卵を買う"));
        assertEquals(200, put.status);
        assertEquals(false, put.map().get("done")); // PUT は全置換なので done はデフォルトに戻る
        assertEquals(created.map().get("createdAt"), put.map().get("createdAt"));

        Res del = call("DELETE", "todos/1");
        assertEquals(204, del.status);
        assertNull(del.json);
        assertEquals(404, call("GET", "todos/1").status);
        assertEquals(404, call("DELETE", "todos/1").status);
    }

    @Test
    void filtersAndSorting() throws Exception {
        call("POST", "todos", Map.of("title", "Apple", "done", true));
        call("POST", "todos", Map.of("title", "banana"));
        call("POST", "todos", Map.of("title", "Pineapple", "done", true));

        assertEquals(List.of(1, 2, 3), ids(call("GET", "todos")));
        assertEquals(List.of(1, 3), ids(call("GET", "todos?done=true")));
        assertEquals(List.of(2), ids(call("GET", "todos?done=false")));
        assertEquals(List.of(1, 3), ids(call("GET", "todos?q=APPLE")));
        // クエリの値は URL デコードされる
        assertEquals(List.of(3), ids(call("GET", "todos?q=pine%61pple&done=true")));
    }

    @Test
    void validationErrors() throws Exception {
        assertEquals(400, call("POST", "todos", "{not json").status);
        assertEquals(400, call("POST", "todos", Map.of()).status);
        assertEquals(400, call("POST", "todos", Map.of("title", "   ")).status);
        assertEquals(400, call("POST", "todos", Map.of("title", "x".repeat(201))).status);
        assertEquals(400, call("POST", "todos", Map.of("title", "ok", "done", "yes")).status);
        assertEquals(400, call("POST", "todos", List.of(1, 2)).status);
        Res empty = call("POST", "todos", "");
        assertEquals(400, empty.status);
        assertEquals("validation_error", empty.map().get("error"));

        call("POST", "todos", Map.of("title", "ok"));
        assertEquals(400, call("PATCH", "todos/1", Map.of("title", "")).status);
        assertEquals(400, call("PUT", "todos/1", Map.of("done", true)).status); // PUTはtitle必須
        assertEquals(404, call("PATCH", "todos/99", Map.of("done", true)).status);
    }

    @Test
    void routingErrors() throws Exception {
        Res nope = call("GET", "nope");
        assertEquals(404, nope.status);
        assertEquals("not_found", nope.map().get("error"));
        assertEquals(404, call("GET", "todos/abc").status);

        Res m = call("DELETE", "todos");
        assertEquals(405, m.status);
        assertEquals("GET, POST", m.header("Allow"));
        assertEquals(List.of("GET", "POST"), m.map().get("allow"));
        assertEquals(405, call("POST", "health").status);
        assertEquals("GET, PUT, PATCH, DELETE", call("POST", "todos/1").header("Allow"));
    }

    @Test
    void resetSeedsSampleData() throws Exception {
        call("POST", "todos", Map.of("title", "temp"));
        assertEquals(204, call("POST", "_reset").status);
        List<Map<String, Object>> list = call("GET", "todos").list();
        assertEquals(3, list.size());
        assertEquals(1, list.get(0).get("id"));
        assertEquals(1, list.stream().filter(t -> Boolean.TRUE.equals(t.get("done"))).count());
    }

    @Test
    void trailingSlashIsIgnored() throws Exception {
        assertEquals(200, call("GET", "todos/").status);
    }
}
