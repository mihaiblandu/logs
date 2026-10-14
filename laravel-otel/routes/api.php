<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\EchoController;
use App\Http\Controllers\TodoController;
use App\Http\Middleware\RequireJwt;
use Illuminate\Support\Facades\Route;

Route::get('/echo', [EchoController::class, 'echo']);
Route::get('/orders/{id}', [EchoController::class, 'order'])->whereNumber('id');
Route::get('/chain', [EchoController::class, 'chain']);

Route::post('/login', [AuthController::class, 'login']);

Route::middleware(RequireJwt::class)->group(function () {
    Route::get('/me', [AuthController::class, 'me']);
    Route::apiResource('todos', TodoController::class);
    Route::post('/todos/{todo}/run', [TodoController::class, 'run']);
    Route::get('/cascade/plan', [TodoController::class, 'plan']);
});
