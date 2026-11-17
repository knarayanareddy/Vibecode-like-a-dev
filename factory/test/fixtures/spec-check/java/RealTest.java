package com.example.billing;

import com.example.billing.domain.InvoiceCalculator;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class RealTest {
    // @anchor __REQ__
    @Test
    void calculatesTotal() {
        var calculator = new InvoiceCalculator();
        assertEquals(200, calculator.sum(120, 80));
    }
}
