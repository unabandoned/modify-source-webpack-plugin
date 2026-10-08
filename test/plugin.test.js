'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const webpack = require('webpack');

const {
  ModifySourcePlugin,
  ConcatOperation,
  ReplaceOperation
} = require('..');

const fixtures = path.join(__dirname, 'fixtures');
const read = name => fs.readFileSync(path.join(fixtures, name), 'utf8');
const marker = new ConcatOperation(
  'end',
  '// [::SOME_UNIQUE_STRING][$FILE_NAME]'
);
const marked = name => `${read(name)}// [::SOME_UNIQUE_STRING][${name}]`;

/** Compile `entry` for real and return the modules' sources and the bundle. */
function compile(entry, plugins, config = {}) {
  const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'modify-source-'));
  const compiler = webpack({
    mode: 'development',
    devtool: false,
    context: fixtures,
    entry: `./${entry}`,
    target: 'node',
    output: {
      path: outputPath,
      filename: 'bundle.js',
      library: { type: 'commonjs2' }
    },
    plugins,
    ...config
  });

  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error) {
        reject(error);
        return;
      }

      compiler.close(() => {
        const sources = {};

        for (const module of stats.compilation.modules) {
          if (module.resource) {
            sources[path.relative(fixtures, module.resource)] = module
              .originalSource()
              .source()
              .toString();
          }
        }

        const bundle = fs.readFileSync(path.join(outputPath, 'bundle.js'), 'utf8');

        fs.rmSync(outputPath, { recursive: true, force: true });
        resolve({ stats, sources, bundle });
      });
    });
  });
}

function assertClean(stats) {
  assert.deepEqual(stats.compilation.errors, []);
  assert.deepEqual(stats.compilation.warnings, []);
}

function exportsOf(bundle) {
  const module = { exports: {} };

  vm.runInNewContext(bundle, { module, exports: module.exports, require });

  return module.exports;
}

for (const [name, regexp, expected] of [
  ['the entry module', /index\.js$/, ['index.js']],
  ['one module by regexp', /one-module\.js$/, ['one-module.js']],
  ['another module by regexp', /two-module\.js$/, ['two-module.js']],
  ['every module', /.+\.js$/, ['index.js', 'one-module.js', 'two-module.js']]
]) {
  test(`ConcatOperation modifies ${name}`, async () => {
    const { stats, sources, bundle } = await compile('index.js', [
      new ModifySourcePlugin({ rules: [{ test: regexp, operations: [marker] }] })
    ]);

    assertClean(stats);

    for (const file of ['index.js', 'one-module.js', 'two-module.js']) {
      const want = expected.includes(file) ? marked(file) : read(file);

      assert.equal(sources[file], want, file);
      assert.equal(
        bundle.includes(`[::SOME_UNIQUE_STRING][${file}]`),
        expected.includes(file),
        `${file} in bundle`
      );
    }
  });
}

test('ReplaceOperation "once" patches a node_modules file, as CyberChef does split.js', async () => {
  const { stats, sources, bundle } = await compile('vendor-entry.js', [
    new ModifySourcePlugin({
      rules: [
        {
          test: /split\.es\.js$/,
          operations: [
            new ReplaceOperation('once', 'if (pixelSize < elementMinSize)', 'if (false)')
          ]
        }
      ]
    })
  ]);

  assertClean(stats);

  const source = sources[path.join('node_modules', 'split-like', 'split.es.js')];

  assert.equal(source.match(/if \(false\)/g).length, 1);
  assert.equal(source.match(/if \(pixelSize < elementMinSize\)/g).length, 1);
  assert.equal(exportsOf(bundle)(1, 2), 'clamped again');
});

test('ReplaceOperation "all", ConcatOperation "start" and constants', async () => {
  const { stats, sources } = await compile('vendor-entry.js', [
    new ModifySourcePlugin({
      constants: { VERDICT: 'free' },
      rules: [
        {
          test: module => module.resource.endsWith('split.es.js'),
          operations: [
            new ReplaceOperation('all', 'if \\(pixelSize < elementMinSize\\)', 'if (false)'),
            new ReplaceOperation('once', "'free'", "'$VERDICT, via $FILE_NAME'"),
            new ConcatOperation('start', '/* $FILE_PATH */\n')
          ]
        }
      ]
    })
  ]);

  assertClean(stats);

  const source = sources[path.join('node_modules', 'split-like', 'split.es.js')];

  assert.equal(source.match(/if \(false\)/g).length, 2);
  assert.match(source, /'free, via split\.es\.js'/);
  // $FILE_PATH is the module's resolved path, with forward slashes.
  const filePath = path
    .join(fixtures, 'node_modules', 'split-like', 'split.es.js')
    .replaceAll('\\', '/');

  assert.ok(source.startsWith(`/* ${filePath} */\n`), source);
});

test('runs before the loaders a project already applies', async () => {
  const { stats, sources } = await compile(
    'index.js',
    [new ModifySourcePlugin({ rules: [{ test: /two-module\.js$/, operations: [marker] }] })],
    {
      module: {
        rules: [{ test: /two-module\.js$/, use: path.join(fixtures, 'upper-loader.js') }]
      }
    }
  );

  assertClean(stats);
  assert.equal(
    sources['two-module.js'],
    marked('two-module.js').replace('two-module', 'TWO-MODULE')
  );
});

test('rejects invalid options when the plugin is constructed', () => {
  assert.throws(
    () => new ModifySourcePlugin({ rules: [{ test: 'index.js' }], extra: true }),
    error =>
      error.name === 'ValidationError' &&
      /ModifySourcePlugin/.test(error.message) &&
      /rules\[0\]\.test should be one of these/.test(error.message) &&
      /has an unknown property 'extra'/.test(error.message)
  );
});
