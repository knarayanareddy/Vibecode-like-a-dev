package com.example.billing

import com.example.billing.domain.InvoiceCalculator
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class RealKotlinTest {
    // @anchor __REQ__
    @Test
    fun calculatesTotal() {
        val calc = InvoiceCalculator()
        assertEquals(200, calc.sum(120, 80))
    }
}
