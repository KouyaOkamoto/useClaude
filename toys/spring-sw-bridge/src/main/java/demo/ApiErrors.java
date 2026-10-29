package demo;

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
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.NoHandlerFoundException;

/**
 * Spring MVC が出すルーティングのエラーを、browser-rest-api と同じ形の JSON にする。
 * （サーバーを立てない構成なので、Spring Boot のエラーページ /error には転送されない）
 */
@RestControllerAdvice
public class ApiErrors {

    /** Allow ヘッダに並べる順番（browser-rest-api と同じ） */
    private static final List<HttpMethod> ORDER =
            List.of(HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH, HttpMethod.DELETE);

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    ResponseEntity<Object> methodNotAllowed(HttpRequestMethodNotSupportedException e) {
        Set<HttpMethod> supported = e.getSupportedHttpMethods();
        List<String> allow = ORDER.stream()
                .filter(m -> supported != null && supported.contains(m))
                .map(HttpMethod::name)
                .collect(Collectors.toList());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "method_not_allowed");
        body.put("allow", allow);
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .header(HttpHeaders.ALLOW, String.join(", ", allow))
                .body(body);
    }

    @ExceptionHandler(NoHandlerFoundException.class)
    ResponseEntity<Object> noRoute(NoHandlerFoundException e) {
        return TodoController.error(HttpStatus.NOT_FOUND, "not_found",
                "no route for " + e.getHttpMethod() + " " + e.getRequestURL());
    }
}
