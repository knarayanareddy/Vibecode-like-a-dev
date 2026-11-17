using Acme.Billing.Domain;
using Xunit;

namespace Acme.Billing.Tests;

public sealed class RealTests
{
    // @anchor __REQ__
    [Fact]
    public void CalculatesTotal()
    {
        var calculator = new InvoiceCalculator();
        Assert.Equal(200, calculator.Sum(new[] { 120, 80 }));
    }
}
