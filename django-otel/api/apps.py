import logging

from django.apps import AppConfig


class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
        # opentelemetry-instrument puts the OTel LoggingHandler on the root logger before Django
        # starts; add the context filter to it (and any other root handler) here.
        from .logging import ContextLogFilter

        for handler in logging.getLogger().handlers:
            handler.addFilter(ContextLogFilter())
