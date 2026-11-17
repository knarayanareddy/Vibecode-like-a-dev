package com.example.billing

import org.junit.jupiter.api.Test
import org.testng.Assert
import kotlin.test.assertEquals

class HollowKotlinTest {
    // @anchor __REQ__
    @Test
    fun importsOnlyTestFrameworks() {
        val items = listOf(1, 2, 3)
        assertEquals(3, items.size)
    }
}
