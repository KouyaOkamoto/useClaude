package demo;

import java.net.URI;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * toys/browser-rest-api（Service Worker の JS 実装）と同じ仕様の Todo API。
 * ステータスコード・バリデーション・エラーの JSON をそろえている。保存先はメモリ上の Map。
 */
@RestController
@RequestMapping("/api")
public class TodoController {

    private static final List<Map<String, Object>> SAMPLE = List.of(
            Map.of("title", "Service Worker でAPIを作る", "done", true),
            Map.of("title", "IndexedDB に保存する", "done", false),
            Map.of("title", "GitHub Pages に置く", "done", false));

    private final Map<Long, Map<String, Object>> items = new LinkedHashMap<>();
    private long seq;
    private final ObjectMapper json;

    TodoController(ObjectMapper json) {
        this.json = json;
    }

    // ------------------------------------------------------------------ 共通

    static ResponseEntity<Object> error(HttpStatus status, String error, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", error);
        body.put("message", message);
        return ResponseEntity.status(status).body(body);
    }

    private static ResponseEntity<Object> badRequest(String message) {
        return error(HttpStatus.BAD_REQUEST, "validation_error", message);
    }

    private static ResponseEntity<Object> todoNotFound(long id) {
        return error(HttpStatus.NOT_FOUND, "not_found", "todo " + id + " not found");
    }

    private static String now() {
        return Instant.now().truncatedTo(ChronoUnit.MILLIS).toString();
    }

    /** 検証の結果。error が null なら value に正規化した値が入る。 */
    private static final class Checked {
        final String error;
        final Map<String, Object> value;

        Checked(String error, Map<String, Object> value) {
            this.error = error;
            this.value = value;
        }
    }

    /** 本文を JSON として読む。読めなければ null。 */
    private Object parse(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return json.readValue(raw, Object.class);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    /** partial=true なら PATCH 用（指定されたフィールドだけ検証） */
    private static Checked validate(Object input, boolean partial) {
        if (!(input instanceof Map)) {
            return new Checked("body must be a JSON object", null);
        }
        Map<?, ?> in = (Map<?, ?>) input;
        Map<String, Object> out = new LinkedHashMap<>();
        if (!partial || in.containsKey("title")) {
            Object title = in.get("title");
            if (!(title instanceof String) || ((String) title).strip().isEmpty() || ((String) title).length() > 200) {
                return new Checked("title must be a non-empty string (max 200 chars)", null);
            }
            out.put("title", ((String) title).strip());
        }
        if (in.containsKey("done")) {
            if (!(in.get("done") instanceof Boolean)) {
                return new Checked("done must be a boolean", null);
            }
            out.put("done", in.get("done"));
        }
        return new Checked(null, out);
    }

    private Map<String, Object> create(String title, boolean done) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", ++seq);
        item.put("title", title);
        item.put("done", done);
        item.put("createdAt", now());
        items.put((Long) item.get("id"), item);
        return item;
    }

    /** テスト用: 中身と採番を空に戻す */
    synchronized void clear() {
        items.clear();
        seq = 0;
    }

    // ------------------------------------------------------------------ ルート

    @GetMapping("")
    public Map<String, Object> index() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "spring-sw-bridge");
        body.put("endpoints", List.of(
                "GET /health",
                "GET /todos?done=true|false&q=text",
                "POST /todos",
                "GET /todos/:id",
                "PUT /todos/:id",
                "PATCH /todos/:id",
                "DELETE /todos/:id",
                "POST /_reset"));
        return body;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "ok");
        body.put("runtime", "spring-boot");
        body.put("java", System.getProperty("java.version"));
        body.put("vm", System.getProperty("java.vm.name"));
        body.put("time", now());
        return body;
    }

    @PostMapping("/_reset")
    public synchronized ResponseEntity<Object> reset() {
        clear();
        for (Map<String, Object> s : SAMPLE) {
            create((String) s.get("title"), (Boolean) s.get("done"));
        }
        return ResponseEntity.noContent().build();
    }

    // ------------------------------------------------------------------ /todos

    @GetMapping("/todos")
    public synchronized List<Map<String, Object>> list(
            @RequestParam(required = false) String done,
            @RequestParam(required = false) String q) {
        return items.values().stream()
                .filter(t -> !"true".equals(done) && !"false".equals(done) || t.get("done").equals(Boolean.valueOf(done)))
                .filter(t -> q == null || q.isEmpty()
                        || ((String) t.get("title")).toLowerCase().contains(q.toLowerCase()))
                .sorted((a, b) -> Long.compare((Long) a.get("id"), (Long) b.get("id")))
                .collect(Collectors.toCollection(ArrayList::new));
    }

    @PostMapping("/todos")
    public synchronized ResponseEntity<Object> post(@RequestBody(required = false) String raw) {
        Object body = parse(raw);
        if (body == null) {
            return badRequest("body must be valid JSON");
        }
        Checked v = validate(body, false);
        if (v.error != null) {
            return badRequest(v.error);
        }
        Map<String, Object> item = create((String) v.value.get("title"), Boolean.TRUE.equals(v.value.get("done")));
        return ResponseEntity.created(URI.create("/api/todos/" + item.get("id"))).body(item);
    }

    // ------------------------------------------------------------------ /todos/{id}

    @GetMapping("/todos/{id:\\d+}")
    public synchronized ResponseEntity<Object> get(@PathVariable long id) {
        Map<String, Object> item = items.get(id);
        return item == null ? todoNotFound(id) : ResponseEntity.ok(item);
    }

    @DeleteMapping("/todos/{id:\\d+}")
    public synchronized ResponseEntity<Object> delete(@PathVariable long id) {
        return items.remove(id) == null ? todoNotFound(id) : ResponseEntity.noContent().build();
    }

    @PutMapping("/todos/{id:\\d+}")
    public synchronized ResponseEntity<Object> put(@PathVariable long id, @RequestBody(required = false) String raw) {
        return update(id, raw, false);
    }

    @PatchMapping("/todos/{id:\\d+}")
    public synchronized ResponseEntity<Object> patch(@PathVariable long id, @RequestBody(required = false) String raw) {
        return update(id, raw, true);
    }

    private ResponseEntity<Object> update(long id, String raw, boolean partial) {
        Map<String, Object> existing = items.get(id);
        if (existing == null) {
            return todoNotFound(id);
        }
        Object body = parse(raw);
        if (body == null) {
            return badRequest("body must be valid JSON");
        }
        Checked v = validate(body, partial);
        if (v.error != null) {
            return badRequest(v.error);
        }
        Map<String, Object> next = new LinkedHashMap<>();
        if (partial) {
            next.putAll(existing);
            next.putAll(v.value);
        } else {
            // PUT は全置換。done を省略したら false に戻る（作成日時は残す）
            next.put("id", id);
            next.put("title", v.value.get("title"));
            next.put("done", Boolean.TRUE.equals(v.value.get("done")));
            next.put("createdAt", existing.get("createdAt"));
        }
        items.put(id, next);
        return ResponseEntity.ok(next);
    }
}
