package demo.kakeibo;

import java.util.ArrayList;
import java.util.List;

/**
 * CSV の読み書き（RFC 4180。区切りはカンマ、" で囲んだ中のカンマ・改行・"" を扱う）。
 * 書き出しは Excel で開けるよう、先頭に BOM を付け、改行を CRLF にする。
 */
final class Csv {
    private Csv() {
    }

    static final String BOM = "﻿";
    static final List<String> HEADER = List.of("日付", "種別", "カテゴリ", "金額", "メモ");

    static String field(String s) {
        if (s == null) {
            return "";
        }
        if (s.contains(",") || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }

    static String line(List<String> fields) {
        List<String> out = new ArrayList<>();
        for (String f : fields) {
            out.add(field(f));
        }
        return String.join(",", out) + "\r\n";
    }

    /** 1行（物理行ではなくレコード）とその開始行番号 */
    static final class Record {
        final int line;
        final List<String> fields;

        Record(int line, List<String> fields) {
            this.line = line;
            this.fields = fields;
        }
    }

    /** CSV を読む。閉じていない " があれば IllegalArgumentException（行番号つき） */
    static List<Record> parse(String text) {
        if (text.startsWith(BOM)) {
            text = text.substring(1);
        }
        List<Record> records = new ArrayList<>();
        List<String> fields = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean quoted = false;
        int line = 1;
        int start = 1;
        boolean any = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (quoted) {
                if (c == '"') {
                    if (i + 1 < text.length() && text.charAt(i + 1) == '"') {
                        cur.append('"');
                        i++;
                    } else {
                        quoted = false;
                    }
                } else {
                    if (c == '\n') {
                        line++;
                    }
                    cur.append(c);
                }
            } else if (c == '"') {
                quoted = true;
                any = true;
            } else if (c == ',') {
                fields.add(cur.toString());
                cur.setLength(0);
                any = true;
            } else if (c == '\r' || c == '\n') {
                if (c == '\r' && i + 1 < text.length() && text.charAt(i + 1) == '\n') {
                    i++;
                }
                fields.add(cur.toString());
                cur.setLength(0);
                if (any || fields.size() > 1 || !fields.get(0).isEmpty()) {
                    records.add(new Record(start, fields));
                }
                fields = new ArrayList<>();
                any = false;
                line++;
                start = line;
            } else {
                cur.append(c);
                any = true;
            }
        }
        if (quoted) {
            throw new IllegalArgumentException(start + " 行目: \" が閉じていません");
        }
        fields.add(cur.toString());
        if (any || fields.size() > 1 || !fields.get(0).isEmpty()) {
            records.add(new Record(start, fields));
        }
        return records;
    }
}
