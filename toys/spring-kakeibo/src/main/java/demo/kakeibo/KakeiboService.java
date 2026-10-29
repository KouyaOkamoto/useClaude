package demo.kakeibo;

import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import javax.persistence.EntityManager;
import javax.persistence.TypedQuery;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 家計簿の中身: 入力の検証、カテゴリと取引の読み書き、集計、CSV、初期化。
 * 書き込みのメソッドは、トランザクションが確定したあとに DB のダンプを保存する（DumpStore）。
 */
@Service
public class KakeiboService {

    static final long MAX_AMOUNT = 9_999_999_999L;
    static final int MAX_IMPORT_ROWS = 10_000;

    private final CategoryRepository categories;
    private final EntryRepository entries;
    private final EntityManager em;
    private final DumpStore store;

    KakeiboService(CategoryRepository categories, EntryRepository entries, EntityManager em, DumpStore store) {
        this.categories = categories;
        this.entries = entries;
        this.em = em;
        this.store = store;
    }

    // ------------------------------------------------------------------ 変換

    static Map<String, Object> json(Category c, Long count) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", c.getId());
        m.put("name", c.getName());
        m.put("type", c.getType().name());
        if (count != null) {
            m.put("transactionCount", count);
        }
        return m;
    }

    static Map<String, Object> json(Entry e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", e.id);
        m.put("date", e.date.toString());
        m.put("amount", e.amount);
        m.put("categoryId", e.category.getId());
        m.put("categoryName", e.category.getName());
        m.put("type", e.category.getType().name());
        m.put("memo", e.memo);
        return m;
    }

    // ------------------------------------------------------------------ 入力の検証

    static Map<?, ?> object(Object body) {
        if (!(body instanceof Map)) {
            throw ApiException.badRequest("body must be a JSON object");
        }
        return (Map<?, ?>) body;
    }

    static String name(Object v) {
        if (!(v instanceof String) || ((String) v).strip().isEmpty() || ((String) v).strip().length() > 50) {
            throw ApiException.badRequest("name must be a non-empty string (max 50 chars)");
        }
        return ((String) v).strip();
    }

    static CategoryType type(Object v) {
        CategoryType t = v instanceof String ? CategoryType.parse((String) v) : null;
        if (t == null) {
            throw ApiException.badRequest("type must be INCOME or EXPENSE");
        }
        return t;
    }

    static LocalDate date(Object v, String field) {
        if (v instanceof String && ((String) v).matches("\\d{4}-\\d{2}-\\d{2}")) {
            try {
                return LocalDate.parse((String) v);
            } catch (DateTimeParseException e) {
                // 下で 400 にする
            }
        }
        throw ApiException.badRequest(field + " must be a date (yyyy-MM-dd)");
    }

    static long amount(Object v) {
        // JSON の整数だけを受け付ける（1.5 や "100" は不可）
        if ((v instanceof Integer || v instanceof Long) && ((Number) v).longValue() >= 1
                && ((Number) v).longValue() <= MAX_AMOUNT) {
            return ((Number) v).longValue();
        }
        throw ApiException.badRequest("amount must be an integer from 1 to " + MAX_AMOUNT + " (yen)");
    }

    static String memo(Object v) {
        if (v == null) {
            return null;
        }
        if (!(v instanceof String) || ((String) v).length() > 200) {
            throw ApiException.badRequest("memo must be a string (max 200 chars)");
        }
        String s = ((String) v).strip();
        return s.isEmpty() ? null : s;
    }

    private Category categoryFor(Object v) {
        if (!(v instanceof Integer || v instanceof Long)) {
            throw ApiException.badRequest("categoryId must be an integer");
        }
        long id = ((Number) v).longValue();
        return categories.findById(id).orElseThrow(() -> ApiException.badRequest("category " + id + " not found"));
    }

    private Category category(long id) {
        return categories.findById(id).orElseThrow(() -> ApiException.notFound("category " + id + " not found"));
    }

    private Entry entry(long id) {
        return entries.findById(id).orElseThrow(() -> ApiException.notFound("transaction " + id + " not found"));
    }

    // ------------------------------------------------------------------ カテゴリ

    @Transactional(readOnly = true)
    public List<Map<String, Object>> listCategories() {
        Map<Long, Long> counts = new HashMap<>();
        for (Object[] row : entries.countByCategory()) {
            counts.put((Long) row[0], (Long) row[1]);
        }
        return categories.findAllOrdered().stream()
                .map(c -> json(c, counts.getOrDefault(c.getId(), 0L)))
                .collect(Collectors.toList());
    }

    @Transactional(readOnly = true)
    public Map<String, Object> getCategory(long id) {
        return json(category(id), null);
    }

    @Transactional
    public Map<String, Object> createCategory(Object body) {
        Map<?, ?> in = object(body);
        String name = name(in.get("name"));
        CategoryType type = type(in.get("type"));
        if (categories.findByName(name).isPresent()) {
            throw ApiException.conflict("category name already exists: " + name);
        }
        Category c = categories.save(new Category(name, type));
        store.saveAfterCommit();
        return json(c, 0L);
    }

    @Transactional
    public Map<String, Object> updateCategory(long id, Object body) {
        Category c = category(id);
        Map<?, ?> in = object(body);
        String name = name(in.get("name"));
        CategoryType type = type(in.get("type"));
        categories.findByName(name).filter(other -> !other.getId().equals(id)).ifPresent(other -> {
            throw ApiException.conflict("category name already exists: " + name);
        });
        c.name = name;
        c.type = type;
        store.saveAfterCommit();
        return json(c, null);
    }

    @Transactional
    public void deleteCategory(long id) {
        Category c = category(id);
        if (entries.existsByCategoryId(id)) {
            throw ApiException.conflict("category " + id + " is used by transactions");
        }
        categories.delete(c);
        store.saveAfterCommit();
    }

    // ------------------------------------------------------------------ 取引

    @Transactional(readOnly = true)
    public List<Map<String, Object>> listEntries(String from, String to, String categoryId, String q) {
        StringBuilder jpql = new StringBuilder("select e from Entry e join fetch e.category c where 1 = 1");
        Map<String, Object> params = new HashMap<>();
        LocalDate f = blank(from) ? null : date(from, "from");
        LocalDate t = blank(to) ? null : date(to, "to");
        if (f != null && t != null && f.isAfter(t)) {
            throw ApiException.badRequest("from must not be after to");
        }
        if (f != null) {
            jpql.append(" and e.date >= :from");
            params.put("from", f);
        }
        if (t != null) {
            jpql.append(" and e.date <= :to");
            params.put("to", t);
        }
        if (!blank(categoryId)) {
            if (!categoryId.matches("\\d{1,18}")) {
                throw ApiException.badRequest("categoryId must be an integer");
            }
            jpql.append(" and c.id = :categoryId");
            params.put("categoryId", Long.parseLong(categoryId));
        }
        if (!blank(q)) {
            jpql.append(" and (lower(e.memo) like :q escape '\\' or lower(c.name) like :q escape '\\')");
            String like = q.toLowerCase().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
            params.put("q", "%" + like + "%");
        }
        jpql.append(" order by e.date desc, e.id desc");
        TypedQuery<Entry> query = em.createQuery(jpql.toString(), Entry.class);
        params.forEach(query::setParameter);
        return query.getResultList().stream().map(KakeiboService::json).collect(Collectors.toList());
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    @Transactional(readOnly = true)
    public Map<String, Object> getEntry(long id) {
        return json(entry(id));
    }

    @Transactional
    public Map<String, Object> createEntry(Object body) {
        Map<?, ?> in = object(body);
        Entry e = entries.save(new Entry(date(in.get("date"), "date"), amount(in.get("amount")),
                categoryFor(in.get("categoryId")), memo(in.get("memo"))));
        store.saveAfterCommit();
        return json(e);
    }

    /** PUT は全置換（memo を省略したら消える） */
    @Transactional
    public Map<String, Object> updateEntry(long id, Object body) {
        Entry e = entry(id);
        Map<?, ?> in = object(body);
        LocalDate date = date(in.get("date"), "date");
        long amount = amount(in.get("amount"));
        Category category = categoryFor(in.get("categoryId"));
        String memo = memo(in.get("memo"));
        e.date = date;
        e.amount = amount;
        e.category = category;
        e.memo = memo;
        store.saveAfterCommit();
        return json(e);
    }

    @Transactional
    public void deleteEntry(long id) {
        entries.delete(entry(id));
        store.saveAfterCommit();
    }

    // ------------------------------------------------------------------ 集計

    @Transactional(readOnly = true)
    public Map<String, Object> summary(String month) {
        YearMonth ym;
        if (blank(month)) {
            ym = YearMonth.now();
        } else {
            if (!month.matches("\\d{4}-\\d{2}")) {
                throw ApiException.badRequest("month must be yyyy-MM");
            }
            try {
                ym = YearMonth.parse(month);
            } catch (DateTimeParseException e) {
                throw ApiException.badRequest("month must be yyyy-MM");
            }
        }
        List<Map<String, Object>> expenses = new ArrayList<>();
        List<Map<String, Object>> incomes = new ArrayList<>();
        long income = 0;
        long expense = 0;
        for (Object[] row : entries.totalsByCategory(ym.atDay(1), ym.atEndOfMonth())) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("categoryId", row[0]);
            m.put("name", row[1]);
            m.put("total", row[3]);
            if (row[2] == CategoryType.INCOME) {
                incomes.add(m);
                income += (Long) row[3];
            } else {
                expenses.add(m);
                expense += (Long) row[3];
            }
        }
        Comparator<Map<String, Object>> byTotalDesc = Comparator.comparing((Map<String, Object> m) -> (Long) m.get("total")).reversed();
        expenses.sort(byTotalDesc);
        incomes.sort(byTotalDesc);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("month", ym.toString());
        out.put("income", income);
        out.put("expense", expense);
        out.put("balance", income - expense);
        out.put("expenses", expenses);
        out.put("incomes", incomes);
        return out;
    }

    // ------------------------------------------------------------------ CSV

    @Transactional(readOnly = true)
    public String exportCsv() {
        StringBuilder out = new StringBuilder(Csv.BOM).append(Csv.line(Csv.HEADER));
        for (Entry e : entries.findAllForExport()) {
            out.append(Csv.line(List.of(e.date.toString(), e.category.getType().label, e.category.getName(),
                    Long.toString(e.amount), e.memo == null ? "" : e.memo)));
        }
        return out.toString();
    }

    private static Map<String, Object> problem(int line, String message) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("line", line);
        m.put("message", message);
        return m;
    }

    /**
     * CSV を取り込む。1行でも問題があれば何も取り込まない（全体を無効にする）。
     * 問題のある行は、行番号つきですべて返す。知らないカテゴリは、種別の列に従って作る
     */
    @Transactional
    public Map<String, Object> importCsv(String text) {
        List<Csv.Record> records;
        try {
            records = Csv.parse(text == null ? "" : text);
        } catch (IllegalArgumentException e) {
            throw new ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "validation_error",
                    "CSV を読めませんでした", List.of(problem(0, e.getMessage())));
        }
        if (records.isEmpty()) {
            throw ApiException.badRequest("CSV が空です");
        }
        List<String> header = records.get(0).fields.stream().map(String::strip).collect(Collectors.toList());
        if (!header.equals(Csv.HEADER)) {
            throw new ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "validation_error",
                    "1行目は見出し（" + String.join(",", Csv.HEADER) + "）にしてください",
                    List.of(problem(records.get(0).line, "見出しが違います: " + String.join(",", header))));
        }
        if (records.size() - 1 > MAX_IMPORT_ROWS) {
            throw ApiException.badRequest("一度に取り込めるのは " + MAX_IMPORT_ROWS + " 行までです");
        }

        // まず全行を確かめる
        Map<String, Category> known = new HashMap<>();
        for (Category c : categories.findAll()) {
            known.put(c.getName(), c);
        }
        Map<String, CategoryType> toCreate = new LinkedHashMap<>();
        List<Map<String, Object>> problems = new ArrayList<>();
        List<Object[]> rows = new ArrayList<>();
        for (Csv.Record r : records.subList(1, records.size())) {
            List<String> f = r.fields;
            if (f.size() != Csv.HEADER.size()) {
                problems.add(problem(r.line, "列の数が " + f.size() + " です（" + Csv.HEADER.size() + " 列にしてください）"));
                continue;
            }
            List<String> errs = new ArrayList<>();
            LocalDate date = null;
            try {
                date = date(f.get(0).strip(), "日付");
            } catch (ApiException e) {
                errs.add("日付は yyyy-MM-dd で書いてください: " + f.get(0));
            }
            CategoryType type = CategoryType.parse(f.get(1));
            if (type == null) {
                errs.add("種別は 収入 か 支出 にしてください: " + f.get(1));
            }
            String name = f.get(2).strip();
            if (name.isEmpty() || name.length() > 50) {
                errs.add("カテゴリは1〜50文字にしてください");
            } else if (type != null) {
                CategoryType existing = known.containsKey(name) ? known.get(name).getType() : toCreate.get(name);
                if (existing != null && existing != type) {
                    errs.add("カテゴリ「" + name + "」は" + existing.label + "として登録されています");
                } else if (existing == null) {
                    toCreate.put(name, type);
                }
            }
            Long amount = null;
            String a = f.get(3).strip().replace(",", "");
            if (a.matches("\\d{1,10}") && Long.parseLong(a) >= 1 && Long.parseLong(a) <= MAX_AMOUNT) {
                amount = Long.parseLong(a);
            } else {
                errs.add("金額は 1〜" + MAX_AMOUNT + " の整数（円）にしてください: " + f.get(3));
            }
            String memo = f.get(4).strip();
            if (memo.length() > 200) {
                errs.add("メモは200文字までです");
            }
            if (errs.isEmpty()) {
                rows.add(new Object[] {date, name, amount, memo.isEmpty() ? null : memo});
            } else {
                problems.add(problem(r.line, String.join(" / ", errs)));
            }
        }
        if (!problems.isEmpty()) {
            throw new ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "validation_error",
                    problems.size() + " 行に問題があるため、何も取り込みませんでした", problems);
        }

        // 問題がなければ、まとめて入れる（途中で失敗したらすべて取り消される）
        for (Map.Entry<String, CategoryType> c : toCreate.entrySet()) {
            known.put(c.getKey(), categories.save(new Category(c.getKey(), c.getValue())));
        }
        for (Object[] row : rows) {
            entries.save(new Entry((LocalDate) row[0], (Long) row[2], known.get((String) row[1]), (String) row[3]));
        }
        entries.flush();
        store.saveAfterCommit();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("imported", rows.size());
        out.put("createdCategories", new ArrayList<>(toCreate.keySet()));
        return out;
    }

    // ------------------------------------------------------------------ 初期化

    /** サンプルデータで初期化する（今月と先月の取引）。途中で失敗したら元のまま */
    @Transactional
    public Map<String, Object> reset() {
        entries.deleteAllInBatch();
        categories.deleteAllInBatch();
        Map<String, Category> byName = new HashMap<>();
        for (String[] c : Samples.CATEGORIES) {
            byName.put(c[0], categories.save(new Category(c[0], CategoryType.valueOf(c[1]))));
        }
        YearMonth now = YearMonth.now();
        for (Object[] e : Samples.ENTRIES) {
            YearMonth ym = now.minusMonths((Integer) e[0]);
            int day = Math.min((Integer) e[1], ym.lengthOfMonth());
            entries.save(new Entry(ym.atDay(day), (Long) e[3], byName.get((String) e[2]), (String) e[4]));
        }
        entries.flush();
        store.saveAfterCommit();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("categories", Samples.CATEGORIES.length);
        out.put("transactions", Samples.ENTRIES.length);
        return out;
    }

    /** テスト用: 空にする */
    @Transactional
    void clear() {
        entries.deleteAllInBatch();
        categories.deleteAllInBatch();
    }
}
