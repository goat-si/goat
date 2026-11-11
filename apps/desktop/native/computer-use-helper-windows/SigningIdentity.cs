using System;
using System.Collections.Generic;

namespace Goat.ComputerUse
{
    internal static class SigningIdentity
    {
        internal static bool SamePublisher(string aSubject, string aThumbprint, string[] aOids, string bSubject, string bThumbprint, string[] bOids)
        {
            var aProfiles = Profiles(aOids);
            var bProfiles = Profiles(bOids);
            if (aProfiles.Count == 0 && bProfiles.Count == 0) return aThumbprint == bThumbprint;
            return aProfiles.Count > 0 && bProfiles.Count > 0 &&
                string.Equals(aSubject, bSubject, StringComparison.Ordinal) && aProfiles.SetEquals(bProfiles);
        }

        static HashSet<string> Profiles(string[] oids)
        {
            var profiles = new HashSet<string>(StringComparer.Ordinal);
            foreach (string oid in oids)
                if (oid != null && oid.StartsWith("1.3.6.1.4.1.311.97.", StringComparison.Ordinal)) profiles.Add(oid);
            return profiles;
        }
    }
}
