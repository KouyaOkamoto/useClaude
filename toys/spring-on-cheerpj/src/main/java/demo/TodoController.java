package demo;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** 検証用の最小コントローラ。保存先はメモリ上のMap（DBは次の段階で検討）。 */
@RestController
@RequestMapping("/api/todos")
public class TodoController {

    private final Map<Long, Map<String, Object>> items = new LinkedHashMap<>();
    private final AtomicLong seq = new AtomicLong();

    @GetMapping
    public synchronized List<Map<String, Object>> list() {
        return new ArrayList<>(items.values());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public synchronized Map<String, Object> create(@RequestBody Map<String, Object> body) {
        long id = seq.incrementAndGet();
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", id);
        item.put("title", String.valueOf(body.getOrDefault("title", "")));
        item.put("done", Boolean.TRUE.equals(body.get("done")));
        items.put(id, item);
        return item;
    }

    @GetMapping("/{id}")
    public synchronized ResponseEntity<Map<String, Object>> get(@PathVariable long id) {
        Map<String, Object> item = items.get(id);
        return item == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(item);
    }
}
