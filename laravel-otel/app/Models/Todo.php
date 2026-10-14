<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable(['title', 'done', 'scenario', 'cascade_status', 'trace_id', 'cascade'])]
class Todo extends Model
{
    protected function casts(): array
    {
        return ['done' => 'boolean', 'cascade' => 'array'];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
