package demo.kakeibo;

/** カテゴリの種別。CSV では「収入」「支出」と書く */
public enum CategoryType {
    INCOME("収入"),
    EXPENSE("支出");

    final String label;

    CategoryType(String label) {
        this.label = label;
    }

    /** "INCOME" / "EXPENSE" / "収入" / "支出" を受け付ける。それ以外は null */
    static CategoryType parse(String s) {
        if (s == null) {
            return null;
        }
        for (CategoryType t : values()) {
            if (t.name().equals(s.trim()) || t.label.equals(s.trim())) {
                return t;
            }
        }
        return null;
    }
}
