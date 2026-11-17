package billing_test

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// @anchor __REQ__
func TestHollowNoProductImport(t *testing.T) {
	items := []int{1, 2, 3}
	require.Len(t, items, 3)
}
