package demo.kakeibo;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;

/**
 * エラーを {error, message} の JSON にそろえる。
 * （サーバーを立てない構成なので、Spring Boot のエラーページ /error には転送されない）
 */
@RestControllerAdvice
public class ApiErrors {

    /** Allow ヘッダに並べる順番 */
    private static final List<HttpMethod> ORDER =
            List.of(HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH, HttpMethod.DELETE);

    static ResponseEntity<Object> body(HttpStatus status, String error, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", error);
        body.put("message", message);
        return ResponseEntity.status(status).body(body);
    }

    @ExceptionHandler(ApiException.class)
    ResponseEntity<Object> api(ApiException e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", e.error);
        body.put("message", e.getMessage());
        if (e.details != null) {
            body.put("errors", e.details);
        }
        return ResponseEntity.status(e.status).body(body);
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    ResponseEntity<Object> methodNotAllowed(HttpRequestMethodNotSupportedException e) {
        Set<HttpMethod> supported = e.getSupportedHttpMethods();
        List<String> allow = ORDER.stream()
                .filter(m -> supported != null && supported.contains(m))
                .map(HttpMethod::name)
                .collect(Collectors.toList());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "method_not_allowed");
        body.put("message", e.getMethod() + " is not allowed here");
        body.put("allow", allow);
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .header(HttpHeaders.ALLOW, String.join(", ", allow))
                .body(body);
    }

    @ExceptionHandler(NoHandlerFoundException.class)
    ResponseEntity<Object> noRoute(NoHandlerFoundException e) {
        return body(HttpStatus.NOT_FOUND, "not_found", "no route for " + e.getHttpMethod() + " " + e.getRequestURL());
    }

    /** パスの {id} などが数字でない */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    ResponseEntity<Object> typeMismatch(MethodArgumentTypeMismatchException e) {
        return body(HttpStatus.BAD_REQUEST, "validation_error", e.getName() + " is invalid: " + e.getValue());
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    ResponseEntity<Object> missing(MissingServletRequestParameterException e) {
        return body(HttpStatus.BAD_REQUEST, "validation_error", e.getParameterName() + " is required");
    }
}
