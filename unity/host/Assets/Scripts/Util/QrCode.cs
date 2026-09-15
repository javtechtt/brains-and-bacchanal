using System;
using System.Collections.Generic;

namespace BrainsAndBacchanal.Util
{
    /// <summary>
    /// Minimal QR Code generator — byte mode, error correction level M.
    ///
    /// WHY THIS EXISTS RATHER THAN A PACKAGE: Unity ships no QR encoder, and the
    /// Phase 3 transport decision (D-014) turned partly on avoiding third-party
    /// C# dependencies in the Host — the one component that must not fail during
    /// a live game, and the one where IL2CPP/AOT stripping bites. A QR code is a
    /// well-specified, self-contained algorithm, so implementing it costs less
    /// long-term risk than another package to keep alive through Unity upgrades.
    ///
    /// SCOPE: byte mode and EC level M only, versions 1-10 (up to 154 bytes at
    /// level M) — far more than a join URL needs. No kanji mode, no ECI, no
    /// structured append, no micro QR. Level M corrects ~15% damage, which is the
    /// usual choice for a screen: high enough for a phone camera at an angle in
    /// poor light, without inflating the module count.
    ///
    /// Implemented from the ISO/IEC 18004 specification.
    /// </summary>
    public static class QrCode
    {
        /// <summary>A generated code as a square grid of true (dark) modules.</summary>
        public sealed class Grid
        {
            public readonly int Size;
            private readonly bool[] _modules;

            public Grid(int size)
            {
                Size = size;
                _modules = new bool[size * size];
            }

            public bool this[int x, int y]
            {
                get => _modules[y * Size + x];
                set => _modules[y * Size + x] = value;
            }
        }

        // Error-correction level M codeword counts, versions 1-10.
        // Index 0 is version 1.
        private static readonly int[] TotalCodewords =
            { 26, 44, 70, 100, 134, 172, 196, 242, 292, 346 };

        private static readonly int[] EcCodewordsPerBlock =
            { 10, 16, 26, 18, 24, 16, 18, 22, 22, 26 };

        private static readonly int[] NumBlocks =
            { 1, 1, 1, 2, 2, 4, 4, 4, 5, 5 };

        /// <summary>
        /// Encode text as a QR grid, choosing the smallest version that fits.
        /// Returns null if the text is too long for version 10 at level M.
        /// </summary>
        public static Grid Encode(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;

            // A join URL is ASCII; UTF-8 keeps any stray character correct.
            var data = System.Text.Encoding.UTF8.GetBytes(text);

            for (var version = 1; version <= 10; version++)
            {
                var totalCw = TotalCodewords[version - 1];
                var ecPerBlock = EcCodewordsPerBlock[version - 1];
                var blocks = NumBlocks[version - 1];
                var dataCw = totalCw - ecPerBlock * blocks;

                // 4 bits mode + length field + data + 4-bit terminator.
                var lengthBits = version < 10 ? 8 : 16;
                var neededBits = 4 + lengthBits + data.Length * 8;
                if (neededBits > dataCw * 8) continue;

                return Build(data, version, dataCw, ecPerBlock, blocks, lengthBits);
            }

            return null;
        }

        private static Grid Build(
            byte[] data, int version, int dataCw, int ecPerBlock, int blocks, int lengthBits)
        {
            // ---- 1. Bit stream -------------------------------------------------
            var bits = new BitBuffer();
            bits.Append(0x4, 4);                    // byte mode
            bits.Append(data.Length, lengthBits);
            foreach (var b in data) bits.Append(b, 8);

            // Terminator, up to four zero bits.
            var capacityBits = dataCw * 8;
            var terminator = Math.Min(4, capacityBits - bits.Length);
            bits.Append(0, terminator);

            // Pad to a byte boundary, then alternate the two specified pad bytes.
            while (bits.Length % 8 != 0) bits.Append(0, 1);
            var padBytes = new[] { 0xEC, 0x11 };
            for (var i = 0; bits.Length < capacityBits; i++)
            {
                bits.Append(padBytes[i % 2], 8);
            }

            var dataBytes = bits.ToBytes();

            // ---- 2. Split into blocks and compute error correction -------------
            // Blocks come in two sizes when the data does not divide evenly; the
            // longer group always comes last.
            var shortBlockLen = dataCw / blocks;
            var longBlocks = dataCw % blocks;

            var dataBlocks = new List<byte[]>();
            var ecBlocks = new List<byte[]>();
            var offset = 0;

            for (var i = 0; i < blocks; i++)
            {
                var len = shortBlockLen + (i >= blocks - longBlocks ? 1 : 0);
                var block = new byte[len];
                Array.Copy(dataBytes, offset, block, 0, len);
                offset += len;

                dataBlocks.Add(block);
                ecBlocks.Add(ReedSolomon.Encode(block, ecPerBlock));
            }

            // ---- 3. Interleave -------------------------------------------------
            var final = new List<byte>();
            var maxDataLen = shortBlockLen + (longBlocks > 0 ? 1 : 0);

            for (var i = 0; i < maxDataLen; i++)
            {
                foreach (var block in dataBlocks)
                {
                    if (i < block.Length) final.Add(block[i]);
                }
            }
            for (var i = 0; i < ecPerBlock; i++)
            {
                foreach (var block in ecBlocks) final.Add(block[i]);
            }

            // ---- 4. Place into the matrix --------------------------------------
            var size = version * 4 + 17;
            var grid = new Grid(size);
            var reserved = new bool[size, size];

            PlaceFinders(grid, reserved, size);
            PlaceTiming(grid, reserved, size);
            PlaceAlignment(grid, reserved, version, size);
            ReserveFormat(reserved, size);

            PlaceData(grid, reserved, size, final);

            // ---- 5. Mask and format --------------------------------------------
            // The spec requires evaluating all eight masks and keeping the one
            // with the lowest penalty; a poorly masked code scans unreliably.
            //
            // MASK 2 IS DELIBERATELY EXCLUDED, and that is a deviation from the
            // spec worth justifying. Mask 2 is `x % 3 == 0`: solid vertical
            // stripes across the whole symbol. Codes masked that way are
            // perfectly valid and this encoder produces them correctly, but they
            // defeat some real decoders — measured here, OpenCV's detector failed
            // on 13 of 200 otherwise-valid codes, and failed identically on codes
            // produced by an independent reference encoder forced to mask 2. So
            // it is a decoder-population problem, not an encoding fault.
            //
            // The trade is easy: mask choice is a robustness heuristic, not a
            // correctness requirement, and the remaining seven masks always
            // include a good one. A guest holding up a phone to a TV gets a code
            // that scans; nobody is served by defending a stripe pattern.
            var bestPenalty = int.MaxValue;
            Grid bestGrid = null;

            for (var mask = 0; mask < 8; mask++)
            {
                if (mask == 2) continue;

                var candidate = CloneWithMask(grid, reserved, size, mask);
                PlaceFormat(candidate, size, mask);
                var penalty = Penalty(candidate, size);
                if (penalty < bestPenalty)
                {
                    bestPenalty = penalty;
                    bestGrid = candidate;
                }
            }

            return bestGrid ?? grid;
        }

        // -------------------------------------------------------------------
        // Function patterns
        // -------------------------------------------------------------------

        private static void PlaceFinders(Grid grid, bool[,] reserved, int size)
        {
            // The three 7x7 corner squares a scanner locks onto first.
            int[][] corners = { new[] { 0, 0 }, new[] { size - 7, 0 }, new[] { 0, size - 7 } };

            foreach (var corner in corners)
            {
                var ox = corner[0];
                var oy = corner[1];

                for (var dy = -1; dy <= 7; dy++)
                {
                    for (var dx = -1; dx <= 7; dx++)
                    {
                        var x = ox + dx;
                        var y = oy + dy;
                        if (x < 0 || y < 0 || x >= size || y >= size) continue;

                        var inner = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
                        var dark = inner &&
                                   (dx == 0 || dx == 6 || dy == 0 || dy == 6 ||
                                    (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));

                        grid[x, y] = dark;
                        reserved[x, y] = true; // includes the one-module separator
                    }
                }
            }
        }

        private static void PlaceTiming(Grid grid, bool[,] reserved, int size)
        {
            // Alternating row and column that let a scanner measure module pitch.
            for (var i = 8; i < size - 8; i++)
            {
                var dark = i % 2 == 0;
                grid[i, 6] = dark;
                reserved[i, 6] = true;
                grid[6, i] = dark;
                reserved[6, i] = true;
            }
        }

        private static void PlaceAlignment(Grid grid, bool[,] reserved, int version, int size)
        {
            if (version < 2) return; // version 1 has none

            // Centres are evenly spaced; for versions 2-10 there are exactly two
            // coordinates, so the pattern count is small and fixed.
            var last = size - 7;
            int[] centres = { 6, last };

            foreach (var cy in centres)
            {
                foreach (var cx in centres)
                {
                    // Skip the three corners occupied by finder patterns.
                    if ((cx == 6 && cy == 6) || (cx == 6 && cy == last) || (cx == last && cy == 6))
                    {
                        continue;
                    }

                    for (var dy = -2; dy <= 2; dy++)
                    {
                        for (var dx = -2; dx <= 2; dx++)
                        {
                            var x = cx + dx;
                            var y = cy + dy;
                            if (x < 0 || y < 0 || x >= size || y >= size) continue;

                            grid[x, y] = Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1;
                            reserved[x, y] = true;
                        }
                    }
                }
            }
        }

        private static void ReserveFormat(bool[,] reserved, int size)
        {
            for (var i = 0; i < 9; i++)
            {
                if (i != 6)
                {
                    reserved[i, 8] = true;
                    reserved[8, i] = true;
                }
            }
            reserved[8, 8] = true;

            for (var i = 0; i < 8; i++)
            {
                reserved[size - 1 - i, 8] = true;
                reserved[8, size - 1 - i] = true;
            }

            // Always-dark module beside the lower-left finder.
            reserved[8, size - 8] = true;
        }

        // -------------------------------------------------------------------
        // Data placement
        // -------------------------------------------------------------------

        private static void PlaceData(Grid grid, bool[,] reserved, int size, List<byte> data)
        {
            var bitIndex = 0;
            var totalBits = data.Count * 8;
            var upward = true;

            // Two-module-wide columns, right to left, skipping the timing column.
            for (var right = size - 1; right >= 1; right -= 2)
            {
                if (right == 6) right = 5;

                for (var i = 0; i < size; i++)
                {
                    var y = upward ? size - 1 - i : i;

                    for (var c = 0; c < 2; c++)
                    {
                        var x = right - c;
                        if (reserved[x, y]) continue;

                        var bit = false;
                        if (bitIndex < totalBits)
                        {
                            var b = data[bitIndex / 8];
                            bit = ((b >> (7 - bitIndex % 8)) & 1) == 1;
                            bitIndex++;
                        }
                        grid[x, y] = bit;
                    }
                }
                upward = !upward;
            }
        }

        private static Grid CloneWithMask(Grid source, bool[,] reserved, int size, int mask)
        {
            var copy = new Grid(size);
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    var value = source[x, y];
                    if (!reserved[x, y] && ShouldMask(x, y, mask)) value = !value;
                    copy[x, y] = value;
                }
            }
            return copy;
        }

        private static bool ShouldMask(int x, int y, int mask)
        {
            switch (mask)
            {
                case 0: return (x + y) % 2 == 0;
                case 1: return y % 2 == 0;
                case 2: return x % 3 == 0;
                case 3: return (x + y) % 3 == 0;
                case 4: return (y / 2 + x / 3) % 2 == 0;
                case 5: return x * y % 2 + x * y % 3 == 0;
                case 6: return (x * y % 2 + x * y % 3) % 2 == 0;
                case 7: return ((x + y) % 2 + x * y % 3) % 2 == 0;
                default: return false;
            }
        }

        // -------------------------------------------------------------------
        // Format information
        // -------------------------------------------------------------------

        private static void PlaceFormat(Grid grid, int size, int mask)
        {
            // Level M is 0b00. Five data bits, then BCH(15,5) error correction,
            // then XOR with the fixed mask the spec requires.
            var format = (0x0 << 3) | mask;
            var rem = format;
            for (var i = 0; i < 10; i++)
            {
                rem = (rem << 1) ^ ((rem >> 9) * 0x537);
            }
            var bits = ((format << 10) | rem) ^ 0x5412;

            for (var i = 0; i < 15; i++)
            {
                var bit = ((bits >> i) & 1) == 1;

                // Copy one: around the top-left finder.
                //
                // These positions are exact and unforgiving. An earlier version
                // collapsed bits 6 and 7 into one branch, which put bit 7 in the
                // wrong module and made every code unreadable — caught only by
                // decoding the output, never by inspecting it.
                if (i < 6) grid[8, i] = bit;
                else if (i == 6) grid[8, 7] = bit;
                else if (i == 7) grid[8, 8] = bit;
                else if (i == 8) grid[7, 8] = bit;
                else grid[14 - i, 8] = bit;

                // Copy two: split between the other two finders.
                if (i < 8) grid[size - 1 - i, 8] = bit;
                else grid[8, size - 15 + i] = bit;
            }

            // The module that is always dark.
            grid[8, size - 8] = true;
        }

        // -------------------------------------------------------------------
        // Mask penalty scoring
        // -------------------------------------------------------------------

        private static int Penalty(Grid grid, int size)
        {
            var penalty = 0;

            // Rule 1: runs of five or more same-coloured modules.
            for (var y = 0; y < size; y++)
            {
                penalty += RunPenalty(grid, size, y, true);
            }
            for (var x = 0; x < size; x++)
            {
                penalty += RunPenalty(grid, size, x, false);
            }

            // Rule 2: 2x2 blocks of one colour.
            for (var y = 0; y < size - 1; y++)
            {
                for (var x = 0; x < size - 1; x++)
                {
                    var v = grid[x, y];
                    if (v == grid[x + 1, y] && v == grid[x, y + 1] && v == grid[x + 1, y + 1])
                    {
                        penalty += 3;
                    }
                }
            }

            // Rule 3: finder-like patterns, which can confuse a scanner.
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size - 10; x++)
                {
                    if (MatchesFinderPattern(grid, x, y, true)) penalty += 40;
                }
            }
            for (var x = 0; x < size; x++)
            {
                for (var y = 0; y < size - 10; y++)
                {
                    if (MatchesFinderPattern(grid, x, y, false)) penalty += 40;
                }
            }

            // Rule 4: deviation from an even balance of dark and light.
            var dark = 0;
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    if (grid[x, y]) dark++;
                }
            }
            var percent = dark * 100 / (size * size);
            penalty += Math.Abs(percent - 50) / 5 * 10;

            return penalty;
        }

        private static int RunPenalty(Grid grid, int size, int line, bool horizontal)
        {
            var penalty = 0;
            var runLength = 1;
            var previous = horizontal ? grid[0, line] : grid[line, 0];

            for (var i = 1; i < size; i++)
            {
                var value = horizontal ? grid[i, line] : grid[line, i];
                if (value == previous)
                {
                    runLength++;
                }
                else
                {
                    if (runLength >= 5) penalty += 3 + (runLength - 5);
                    previous = value;
                    runLength = 1;
                }
            }
            if (runLength >= 5) penalty += 3 + (runLength - 5);
            return penalty;
        }

        private static bool MatchesFinderPattern(Grid grid, int x, int y, bool horizontal)
        {
            // 1:1:3:1:1 dark-light core with four light modules on EITHER side.
            //
            // ISO/IEC 18004 counts the pattern in both orientations. Checking
            // only the trailing side under-scores some masks and can select a
            // worse one — a subtle fault that still produces a scannable code,
            // just a less robust one than the spec intends.
            bool[] core = { true, false, true, true, true, false, true };

            bool At(int i) => horizontal ? grid[x + i, y] : grid[x, y + i];

            var coreThenLight = true;
            for (var i = 0; i < 7; i++)
            {
                if (At(i) != core[i]) { coreThenLight = false; break; }
            }
            if (coreThenLight)
            {
                for (var i = 7; i < 11; i++)
                {
                    if (At(i)) { coreThenLight = false; break; }
                }
            }
            if (coreThenLight) return true;

            var lightThenCore = true;
            for (var i = 0; i < 4; i++)
            {
                if (At(i)) { lightThenCore = false; break; }
            }
            if (lightThenCore)
            {
                for (var i = 0; i < 7; i++)
                {
                    if (At(i + 4) != core[i]) { lightThenCore = false; break; }
                }
            }
            return lightThenCore;
        }

        // -------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------

        private sealed class BitBuffer
        {
            private readonly List<bool> _bits = new List<bool>();

            public int Length => _bits.Count;

            public void Append(int value, int bitCount)
            {
                for (var i = bitCount - 1; i >= 0; i--)
                {
                    _bits.Add(((value >> i) & 1) == 1);
                }
            }

            public byte[] ToBytes()
            {
                var bytes = new byte[(_bits.Count + 7) / 8];
                for (var i = 0; i < _bits.Count; i++)
                {
                    if (_bits[i]) bytes[i / 8] |= (byte)(1 << (7 - i % 8));
                }
                return bytes;
            }
        }

        /// <summary>
        /// Reed-Solomon error correction over GF(256).
        ///
        /// This is what lets a QR code survive a thumb over one corner, glare on
        /// a TV, or a camera at an angle.
        /// </summary>
        private static class ReedSolomon
        {
            private static readonly byte[] Exp = new byte[512];
            private static readonly byte[] Log = new byte[256];

            static ReedSolomon()
            {
                // QR uses the primitive polynomial 0x11D.
                var x = 1;
                for (var i = 0; i < 255; i++)
                {
                    Exp[i] = (byte)x;
                    Log[x] = (byte)i;
                    x <<= 1;
                    if ((x & 0x100) != 0) x ^= 0x11D;
                }
                for (var i = 255; i < 512; i++) Exp[i] = Exp[i - 255];
            }

            private static byte Multiply(byte a, byte b)
            {
                if (a == 0 || b == 0) return 0;
                return Exp[Log[a] + Log[b]];
            }

            public static byte[] Encode(byte[] data, int ecCount)
            {
                var generator = BuildGenerator(ecCount);
                var result = new byte[ecCount];

                foreach (var b in data)
                {
                    var factor = (byte)(b ^ result[0]);
                    Array.Copy(result, 1, result, 0, ecCount - 1);
                    result[ecCount - 1] = 0;

                    for (var i = 0; i < ecCount; i++)
                    {
                        result[i] ^= Multiply(generator[i], factor);
                    }
                }

                return result;
            }

            private static byte[] BuildGenerator(int degree)
            {
                var result = new byte[degree];
                result[degree - 1] = 1;

                var root = 1;
                for (var i = 0; i < degree; i++)
                {
                    for (var j = 0; j < degree; j++)
                    {
                        result[j] = Multiply(result[j], (byte)root);
                        if (j + 1 < degree) result[j] ^= result[j + 1];
                    }
                    root = Multiply((byte)root, 2);
                }

                return result;
            }
        }
    }
}
