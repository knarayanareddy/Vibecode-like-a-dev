package billing_test

import (
	"testing"

	"example.com/app/internal/billing"
)

// @anchor __REQ__
func TestCalculateTotal(t *testing.T) {
	got := billing.CalculateTotal([]int{120, 80})
	if got != 200 {
		t.Fatalf("got %d, want 200", got)
	}
}
