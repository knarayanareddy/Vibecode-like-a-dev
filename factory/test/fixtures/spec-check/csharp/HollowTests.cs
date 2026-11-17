using System.Collections.Generic;
using Xunit;

namespace Acme.Billing.Tests;

public sealed class HollowTests
{
    // @anchor __REQ__
    [Fact]
    public void ImportsOnlySystemAndXunit()
    {
        var items = new List<int> { 1, 2, 3 };
        Assert.Equal(3, items.Count);
    }
}
