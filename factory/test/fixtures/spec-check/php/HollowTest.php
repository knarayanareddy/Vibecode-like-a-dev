<?php

declare(strict_types=1);

namespace Tests\Unit;

use PHPUnit\Framework\TestCase;

final class HollowTest extends TestCase
{
    // @anchor __REQ__
    public function testImportsOnlyPhpunit(): void
    {
        $items = [1, 2, 3];
        $this->assertCount(3, $items);
    }
}
