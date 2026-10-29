package demo.kakeibo;

import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;

/** API のエラー。ApiErrors で {error, message[, errors]} の JSON にする */
public class ApiException extends RuntimeException {
    final HttpStatus status;
    final String error;
    /** CSV の取り込みなど、行ごとの問題 */
    final List<Map<String, Object>> details;

    ApiException(HttpStatus status, String error, String message, List<Map<String, Object>> details) {
        super(message);
        this.status = status;
        this.error = error;
        this.details = details;
    }

    static ApiException badRequest(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "validation_error", message, null);
    }

    static ApiException notFound(String message) {
        return new ApiException(HttpStatus.NOT_FOUND, "not_found", message, null);
    }

    static ApiException conflict(String message) {
        return new ApiException(HttpStatus.CONFLICT, "conflict", message, null);
    }
}
