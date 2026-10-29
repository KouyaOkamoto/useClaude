package demo.kakeibo;

import java.net.URI;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 家計簿の API（すべて /api 配下） */
@RestController
@RequestMapping("/api")
public class KakeiboController {

    private final KakeiboService service;
    private final DumpStore store;
    private final ObjectMapper json;

    KakeiboController(KakeiboService service, DumpStore store, ObjectMapper json) {
        this.service = service;
        this.store = store;
        this.json = json;
    }

    /** 本文を JSON として読む。読めなければ 400 */
    private Object parse(String raw) {
        if (raw == null || raw.isBlank()) {
            throw ApiException.badRequest("body must be valid JSON");
        }
        try {
            return json.readValue(raw, Object.class);
        } catch (JsonProcessingException e) {
            throw ApiException.badRequest("body must be valid JSON");
        }
    }

    private static ResponseEntity<Object> created(String path, Map<String, Object> body) {
        return ResponseEntity.created(URI.create("/api/" + path + "/" + body.get("id"))).body(body);
    }

    /** ダウンロードさせるファイル（ファイル名は日本語を含まないので filename= だけでよい） */
    private static ResponseEntity<Object> download(String text, String contentType, String filename) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, contentType)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .body(text);
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "ok");
        body.put("runtime", "spring-boot");
        body.put("java", System.getProperty("java.version"));
        body.put("vm", System.getProperty("java.vm.name"));
        body.put("persistence", store.status());
        return body;
    }

    // ------------------------------------------------------------------ カテゴリ

    @GetMapping("/categories")
    public List<Map<String, Object>> categories() {
        return service.listCategories();
    }

    @PostMapping("/categories")
    public ResponseEntity<Object> createCategory(@RequestBody(required = false) String raw) {
        return created("categories", service.createCategory(parse(raw)));
    }

    @GetMapping("/categories/{id:\\d+}")
    public Map<String, Object> category(@PathVariable long id) {
        return service.getCategory(id);
    }

    @PutMapping("/categories/{id:\\d+}")
    public Map<String, Object> updateCategory(@PathVariable long id, @RequestBody(required = false) String raw) {
        return service.updateCategory(id, parse(raw));
    }

    @DeleteMapping("/categories/{id:\\d+}")
    public ResponseEntity<Object> deleteCategory(@PathVariable long id) {
        service.deleteCategory(id);
        return ResponseEntity.noContent().build();
    }

    // ------------------------------------------------------------------ 取引

    @GetMapping("/transactions")
    public List<Map<String, Object>> transactions(
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to,
            @RequestParam(required = false) String categoryId,
            @RequestParam(required = false) String q) {
        return service.listEntries(from, to, categoryId, q);
    }

    @PostMapping("/transactions")
    public ResponseEntity<Object> createTransaction(@RequestBody(required = false) String raw) {
        return created("transactions", service.createEntry(parse(raw)));
    }

    @GetMapping("/transactions/{id:\\d+}")
    public Map<String, Object> transaction(@PathVariable long id) {
        return service.getEntry(id);
    }

    @PutMapping("/transactions/{id:\\d+}")
    public Map<String, Object> updateTransaction(@PathVariable long id, @RequestBody(required = false) String raw) {
        return service.updateEntry(id, parse(raw));
    }

    @DeleteMapping("/transactions/{id:\\d+}")
    public ResponseEntity<Object> deleteTransaction(@PathVariable long id) {
        service.deleteEntry(id);
        return ResponseEntity.noContent().build();
    }

    // ------------------------------------------------------------------ 集計・CSV・バックアップ

    @GetMapping("/summary")
    public Map<String, Object> summary(@RequestParam(required = false) String month) {
        return service.summary(month);
    }

    @GetMapping("/export.csv")
    public ResponseEntity<Object> exportCsv() {
        return download(service.exportCsv(), "text/csv; charset=UTF-8", "kakeibo-" + LocalDate.now() + ".csv");
    }

    @PostMapping("/import")
    public Map<String, Object> importCsv(@RequestBody(required = false) String text) {
        return service.importCsv(text);
    }

    @GetMapping("/backup.sql")
    public ResponseEntity<Object> backup() {
        return download(store.backup(), MediaType.TEXT_PLAIN_VALUE + "; charset=UTF-8", "kakeibo-backup-" + LocalDate.now() + ".sql");
    }

    @PostMapping("/restore")
    public Map<String, Object> restore(@RequestBody(required = false) String script) {
        return store.restore(script);
    }

    @PostMapping("/_reset")
    public Map<String, Object> reset() {
        return service.reset();
    }
}
