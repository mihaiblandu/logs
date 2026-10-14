FROM php:8.4-cli

# opentelemetry: required by the auto-instrumentation hooks; protobuf: faster OTLP encoding
RUN apt-get update && apt-get install -y --no-install-recommends unzip libzip-dev \
    && pecl install opentelemetry-1.2.0 protobuf \
    && docker-php-ext-enable opentelemetry protobuf \
    && docker-php-ext-install zip \
    && rm -rf /var/lib/apt/lists/* /tmp/pear

COPY --from=composer:2.8 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --no-interaction
COPY . .
RUN composer dump-autoload --optimize --no-dev && php artisan package:discover

# PHP_CLI_SERVER_WORKERS lets `artisan serve` handle concurrent requests (e.g. /api/chain calling out)
ENV PHP_CLI_SERVER_WORKERS=4
EXPOSE 8000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000", "--no-reload"]
