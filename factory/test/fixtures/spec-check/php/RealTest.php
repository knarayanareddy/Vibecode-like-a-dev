<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Billing\InvoiceCalculator;
use PHPUnit\Framework\TestCase;

final class RealTest extends TestCase
{
    // @anchor __REQ__
    public function testCalculatesTotal(): void
    {
        $calculator = new InvoiceCalculator();
        $this->assertSame(200, $calculator->sum([120, 80]));
    }
}
