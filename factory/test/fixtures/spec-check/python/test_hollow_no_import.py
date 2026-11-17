import pytest
import unittest
from hypothesis import given, strategies as st


# @anchor __REQ__
def test_only_test_libraries():
    items = [1, 2, 3]
    assert len(items) == 3
