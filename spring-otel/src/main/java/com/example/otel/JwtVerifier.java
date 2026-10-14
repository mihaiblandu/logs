package com.example.otel;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Validates the HS256 tokens issued by the Laravel app (shared secret, issuer, audience, expiry). */
@Component
public class JwtVerifier {

    private static final long LEEWAY_SECONDS = 30;

    private final MACVerifier verifier;

    public JwtVerifier(@Value("${JWT_SECRET:dev-only-shared-secret-change-me-0123456789abcdef}") String secret)
            throws Exception {
        this.verifier = new MACVerifier(secret.getBytes(StandardCharsets.UTF_8));
    }

    /** @throws IllegalArgumentException with the reason when the token is not acceptable */
    public JWTClaimsSet verify(String authorizationHeader) {
        if (authorizationHeader == null || !authorizationHeader.startsWith("Bearer ")) {
            throw new IllegalArgumentException("missing token");
        }
        try {
            SignedJWT jwt = SignedJWT.parse(authorizationHeader.substring(7));
            if (!JWSAlgorithm.HS256.equals(jwt.getHeader().getAlgorithm()) || !jwt.verify(verifier)) {
                throw new IllegalArgumentException("invalid signature");
            }
            JWTClaimsSet claims = jwt.getJWTClaimsSet();
            Date exp = claims.getExpirationTime();
            if (exp == null || exp.toInstant().plusSeconds(LEEWAY_SECONDS).isBefore(Instant.now())) {
                throw new IllegalArgumentException("token expired");
            }
            if (!"laravel-otel".equals(claims.getIssuer())) {
                throw new IllegalArgumentException("invalid issuer");
            }
            if (claims.getAudience() == null || !claims.getAudience().contains("otel-demo")) {
                throw new IllegalArgumentException("invalid audience");
            }
            return claims;
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalArgumentException(e.getMessage(), e);
        }
    }
}
