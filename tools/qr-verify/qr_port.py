"""
Line-by-line port of unity/host/Assets/Scripts/Util/QrCode.cs.

Purpose: verify the C# QR encoder produces a REAL, decodable QR code before it
is put in front of a phone camera. The Phase 4 spec is explicit that generating
an image is not evidence the code scans.

This port must mirror the C# exactly. Any difference from the reference encoder
is a bug in the C#, not here.
"""

TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

# --- GF(256) ---------------------------------------------------------------
EXP = [0] * 512
LOG = [0] * 256
_x = 1
for _i in range(255):
    EXP[_i] = _x
    LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    EXP[_i] = EXP[_i - 255]


def gf_mul(a, b):
    if a == 0 or b == 0:
        return 0
    return EXP[LOG[a] + LOG[b]]


def build_generator(degree):
    result = [0] * degree
    result[degree - 1] = 1
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = gf_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = gf_mul(root, 2)
    return result


def rs_encode(data, ec_count):
    generator = build_generator(ec_count)
    result = [0] * ec_count
    for b in data:
        factor = b ^ result[0]
        result = result[1:] + [0]
        for i in range(ec_count):
            result[i] ^= gf_mul(generator[i], factor)
    return result


class BitBuffer:
    def __init__(self):
        self.bits = []

    def append(self, value, count):
        for i in range(count - 1, -1, -1):
            self.bits.append((value >> i) & 1 == 1)

    def to_bytes(self):
        out = bytearray((len(self.bits) + 7) // 8)
        for i, bit in enumerate(self.bits):
            if bit:
                out[i // 8] |= 1 << (7 - i % 8)
        return list(out)


def should_mask(x, y, mask):
    if mask == 0:
        return (x + y) % 2 == 0
    if mask == 1:
        return y % 2 == 0
    if mask == 2:
        return x % 3 == 0
    if mask == 3:
        return (x + y) % 3 == 0
    if mask == 4:
        return (y // 2 + x // 3) % 2 == 0
    if mask == 5:
        return (x * y) % 2 + (x * y) % 3 == 0
    if mask == 6:
        return ((x * y) % 2 + (x * y) % 3) % 2 == 0
    if mask == 7:
        return ((x + y) % 2 + (x * y) % 3) % 2 == 0
    return False


def place_finders(grid, reserved, size):
    for ox, oy in ((0, 0), (size - 7, 0), (0, size - 7)):
        for dy in range(-1, 8):
            for dx in range(-1, 8):
                x, y = ox + dx, oy + dy
                if x < 0 or y < 0 or x >= size or y >= size:
                    continue
                inner = 0 <= dx <= 6 and 0 <= dy <= 6
                dark = inner and (
                    dx == 0 or dx == 6 or dy == 0 or dy == 6
                    or (2 <= dx <= 4 and 2 <= dy <= 4)
                )
                grid[y][x] = dark
                reserved[y][x] = True


def place_timing(grid, reserved, size):
    for i in range(8, size - 8):
        dark = i % 2 == 0
        grid[6][i] = dark
        reserved[6][i] = True
        grid[i][6] = dark
        reserved[i][6] = True


def place_alignment(grid, reserved, version, size):
    if version < 2:
        return
    last = size - 7
    centres = [6, last]
    for cy in centres:
        for cx in centres:
            if (cx == 6 and cy == 6) or (cx == 6 and cy == last) or (cx == last and cy == 6):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    x, y = cx + dx, cy + dy
                    if x < 0 or y < 0 or x >= size or y >= size:
                        continue
                    grid[y][x] = max(abs(dx), abs(dy)) != 1
                    reserved[y][x] = True


def reserve_format(reserved, size):
    for i in range(9):
        if i != 6:
            reserved[8][i] = True
            reserved[i][8] = True
    reserved[8][8] = True
    for i in range(8):
        reserved[8][size - 1 - i] = True
        reserved[size - 1 - i][8] = True
    reserved[size - 8][8] = True


def place_data(grid, reserved, size, data):
    bit_index = 0
    total_bits = len(data) * 8
    upward = True
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for i in range(size):
            y = size - 1 - i if upward else i
            for c in range(2):
                x = right - c
                if reserved[y][x]:
                    continue
                bit = False
                if bit_index < total_bits:
                    b = data[bit_index // 8]
                    bit = (b >> (7 - bit_index % 8)) & 1 == 1
                    bit_index += 1
                grid[y][x] = bit
        upward = not upward
        right -= 2


def place_format(grid, size, mask):
    fmt = (0x0 << 3) | mask
    rem = fmt
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    bits = ((fmt << 10) | rem) ^ 0x5412
    for i in range(15):
        bit = (bits >> i) & 1 == 1
        if i < 6:
            grid[i][8] = bit
        elif i == 6:
            grid[7][8] = bit
        elif i == 7:
            grid[8][8] = bit
        elif i == 8:
            grid[8][7] = bit
        else:
            grid[8][14 - i] = bit

        if i < 8:
            grid[8][size - 1 - i] = bit
        else:
            grid[size - 15 + i][8] = bit
    grid[size - 8][8] = True


def run_penalty(grid, size, line, horizontal):
    penalty = 0
    run = 1
    prev = grid[line][0] if horizontal else grid[0][line]
    for i in range(1, size):
        value = grid[line][i] if horizontal else grid[i][line]
        if value == prev:
            run += 1
        else:
            if run >= 5:
                penalty += 3 + (run - 5)
            prev = value
            run = 1
    if run >= 5:
        penalty += 3 + (run - 5)
    return penalty


def matches_finder(grid, x, y, horizontal, size):
    def at(i):
        return grid[y][x + i] if horizontal else grid[y + i][x]
    # 1:1:3:1:1 core with four light modules on EITHER side (ISO/IEC 18004).
    core = [True, False, True, True, True, False, True]
    before = all(not at(i) for i in range(0, 4)) and [at(i) for i in range(4, 11)] == core
    after = [at(i) for i in range(0, 7)] == core and all(not at(i) for i in range(7, 11))
    return before or after


def penalty_score(grid, size):
    penalty = 0
    for y in range(size):
        penalty += run_penalty(grid, size, y, True)
    for x in range(size):
        penalty += run_penalty(grid, size, x, False)

    for y in range(size - 1):
        for x in range(size - 1):
            v = grid[y][x]
            if v == grid[y][x + 1] == grid[y + 1][x] == grid[y + 1][x + 1]:
                penalty += 3

    for y in range(size):
        for x in range(size - 10):
            if matches_finder(grid, x, y, True, size):
                penalty += 40
    for x in range(size):
        for y in range(size - 10):
            if matches_finder(grid, x, y, False, size):
                penalty += 40

    dark = sum(1 for row in grid for v in row if v)
    percent = dark * 100 // (size * size)
    penalty += abs(percent - 50) // 5 * 10
    return penalty


def encode(text):
    data = text.encode("utf-8")
    for version in range(1, 11):
        total_cw = TOTAL_CODEWORDS[version - 1]
        ec_per_block = EC_PER_BLOCK[version - 1]
        blocks = NUM_BLOCKS[version - 1]
        data_cw = total_cw - ec_per_block * blocks
        length_bits = 8 if version < 10 else 16
        needed = 4 + length_bits + len(data) * 8
        if needed > data_cw * 8:
            continue
        return build(data, version, data_cw, ec_per_block, blocks, length_bits)
    return None


def build(data, version, data_cw, ec_per_block, blocks, length_bits):
    bits = BitBuffer()
    bits.append(0x4, 4)
    bits.append(len(data), length_bits)
    for b in data:
        bits.append(b, 8)

    capacity = data_cw * 8
    terminator = min(4, capacity - len(bits.bits))
    bits.append(0, terminator)
    while len(bits.bits) % 8 != 0:
        bits.append(0, 1)
    pad = [0xEC, 0x11]
    i = 0
    while len(bits.bits) < capacity:
        bits.append(pad[i % 2], 8)
        i += 1

    data_bytes = bits.to_bytes()

    short_len = data_cw // blocks
    long_blocks = data_cw % blocks

    data_blocks, ec_blocks = [], []
    offset = 0
    for i in range(blocks):
        length = short_len + (1 if i >= blocks - long_blocks else 0)
        block = data_bytes[offset:offset + length]
        offset += length
        data_blocks.append(block)
        ec_blocks.append(rs_encode(block, ec_per_block))

    final = []
    max_len = short_len + (1 if long_blocks > 0 else 0)
    for i in range(max_len):
        for block in data_blocks:
            if i < len(block):
                final.append(block[i])
    for i in range(ec_per_block):
        for block in ec_blocks:
            final.append(block[i])

    size = version * 4 + 17
    grid = [[False] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]

    place_finders(grid, reserved, size)
    place_timing(grid, reserved, size)
    place_alignment(grid, reserved, version, size)
    reserve_format(reserved, size)
    place_data(grid, reserved, size, final)

    best_grid, best_penalty = None, None
    for mask in range(8):
        if mask == 2:
            continue
        candidate = [row[:] for row in grid]
        for y in range(size):
            for x in range(size):
                if not reserved[y][x] and should_mask(x, y, mask):
                    candidate[y][x] = not candidate[y][x]
        place_format(candidate, size, mask)
        p = penalty_score(candidate, size)
        if best_penalty is None or p < best_penalty:
            best_penalty, best_grid = p, candidate

    return best_grid


if __name__ == "__main__":
    import sys
    g = encode(sys.argv[1] if len(sys.argv) > 1 else "http://192.168.1.10:3000/join/BX7K")
    for row in g:
        print("".join("##" if v else "  " for v in row))
