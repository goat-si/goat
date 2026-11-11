using System;
using Goat.ComputerUse;

internal static class SigningIdentityTest
{
    static void Check(bool expected, string aSubject, string aThumb, string[] aOids, string bSubject, string bThumb, string[] bOids)
    {
        bool actual = SigningIdentity.SamePublisher(aSubject, aThumb, aOids, bSubject, bThumb, bOids);
        if (actual != expected) throw new Exception("Expected " + expected + " for " + aThumb + " / " + bThumb);
    }

    static void Main()
    {
        string[] profile = { "1.3.6.1.4.1.311.97.123", "1.3.6.1.5.5.7.3.3" };
        string[] sameProfile = { "1.3.6.1.5.5.7.3.3", "1.3.6.1.4.1.311.97.123" };
        string[] other = { "1.3.6.1.4.1.311.97.456" };
        string[] none = { "1.3.6.1.5.5.7.3.3" };
        Check(true, "CN=GOAT", "A", profile, "CN=GOAT", "B", sameProfile);
        Check(false, "CN=GOAT", "A", profile, "CN=GOAT", "A", other);
        Check(false, "CN=GOAT", "A", profile, "CN=Other", "A", profile);
        Check(false, "CN=GOAT", "A", profile, "CN=GOAT", "A", none);
        Check(false, "CN=GOAT", "A", none, "CN=GOAT", "A", profile);
        Check(true, "CN=GOAT", "A", none, "CN=Other", "A", none);
        Check(false, "CN=GOAT", "A", none, "CN=GOAT", "B", none);
        Console.WriteLine("Signing identity cases passed");
    }
}
