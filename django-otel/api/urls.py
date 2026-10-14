from django.urls import path

from . import cascade, views

urlpatterns = [
    path("echo", views.echo),
    path("orders/<int:order_id>", views.order),
    path("chain", views.chain),
    path("cascade", cascade.cascade),
]
