const crypto = require("crypto");
const fs = require("fs");
const { PassThrough } = require("stream");
const util = require("util");

const LRU = require("lru-cache");
const pMap = require("p-map");
const tmp = require("tmp-promise");
const { RandomAccessReader } = require("yauzl");

const close = util.promisify(fs.close);
const exists = util.promisify(fs.exists);
const open = util.promisify(fs.open);
const read = util.promisify(fs.read);
const unlink = util.promisify(fs.unlink);
const writeFile = util.promisify(fs.writeFile);

const DEFAULT_BLOCK_SIZE = 1e6; // 1MB

const CACHE = LRU({
  max: 500e6, // 500MB
  length: (n, key) => n.length,
  dispose: async (key, n) => {
    if (await exists(n.filename)) {
      try {
        await unlink(n.filename);
      } catch (err) {
        console.warn(err.stack);
      }
    }
  }
});

tmp.setGracefulCleanup();

class BlockReader extends RandomAccessReader {
  constructor(blockSize = DEFAULT_BLOCK_SIZE) {
    super();

    this.blockSize = blockSize;
    this.blocks = [];
  }

  cacheKey(blockNumber) {
    throw new Error("Not implemented.");
  }

  readBlock() {
    throw new Error("Not implemented.");
  }

  close(callback) {
    super.close(async err => {
      if (err) {
        console.warn(err.stack);
      }

      this.blocks.forEach(i => CACHE.del(this.cacheKey(i)));

      return callback();
    });
  }

  async readFromBlock(start, end, blockNumber) {
    const blockStart = blockNumber * this.blockSize;
    const blockEnd = (blockNumber + 1) * this.blockSize - 1;

    let position;
    if (start < blockStart) {
      position = 0;
    } else {
      position = start % this.blockSize;
    }

    let length;
    if (end > blockEnd) {
      length = this.blockSize - position;
    } else {
      length = (end % this.blockSize) - position;
    }

    const key = this.cacheKey(blockNumber);
    let blockMeta = CACHE.get(key);

    if (blockMeta == null || !(await exists(blockMeta.filename))) {
      const block = await this.readBlock(blockStart, blockEnd);

      const { path: filename } = await tmp.file({
        prefix:
          crypto
            .createHash("sha256")
            .update(key)
            .digest("hex") + "-"
      });

      await writeFile(filename, block);

      CACHE.set(key, {
        filename,
        length: block.length
      });
      this.blocks.push(blockNumber);

      return block.slice(position, position + length);
    } else {
      const fd = await open(blockMeta.filename, "r");
      const out = Buffer.alloc(length);

      await read(fd, out, 0, length, position);

      await close(fd);

      return out;
    }
  }

  async fetchInto(start, end, rs) {
    try {
      const firstBlock = Math.floor(start / this.blockSize);
      const lastBlock = Math.floor((end - 1) / this.blockSize);

      // range(firstBlock, lastBlock + 1)
      const blocks = [...Array(lastBlock - firstBlock + 1).keys()].map(
        x => x + firstBlock
      );

      const buf = await pMap(blocks, this.readFromBlock.bind(this, start, end), {
        concurrency: 8
      });

      rs.end(Buffer.concat(buf));
    } catch (err) {
      console.warn(err.stack);
      rs.emit("error", err);
    }
  }

  _readStreamForRange(start, end) {
    const rs = new PassThrough();

    this.fetchInto(start, end, rs);

    return rs;
  }
}

module.exports = BlockReader;