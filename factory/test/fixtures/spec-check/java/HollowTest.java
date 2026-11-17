package com.example.billing;

import java.util.List;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertEquals;

class HollowTest {
    // @anchor __REQ__
    @Test
    void importsOnlyJunitAndAssertj() {
        var items = List.of(1, 2, 3);
        assertThat(items).hasSize(3);
        assertEquals(3, items.size());
    }
}
