/* eslint-disable no-console */
/**
 * This file contains a CLI for Linaria.
 */

import fs from 'fs';
import path from 'path';

import glob from 'glob';
import mkdirp from 'mkdirp';
import normalize from 'normalize-path';
import yargs from 'yargs';

import type { CodeCache, Module } from '@linaria/babel-preset';
import { transform } from '@linaria/babel-preset';
import { asyncResolveFallback } from '@linaria/utils';

const modulesOptions = [
  'commonjs',
  'es2015',
  'es6',
  'esnext',
  'native',
] as const;

const argv = yargs
  .usage('Usage: $0 [options] <files ...>')
  .option('config', {
    alias: 'c',
    type: 'string',
    description: 'Path to a config file',
    requiresArg: true,
  })
  .option('out-dir', {
    alias: 'o',
    type: 'string',
    description: 'Output directory for the extracted CSS files',
    demandOption: true,
    requiresArg: true,
  })
  .option('source-maps', {
    alias: 's',
    type: 'boolean',
    description: 'Generate source maps for the CSS files',
    default: false,
  })
  .option('source-root', {
    alias: 'r',
    type: 'string',
    description: 'Directory containing the source JS files',
    demandOption: true,
    requiresArg: true,
  })
  .option('insert-css-requires', {
    alias: 'i',
    type: 'string',
    description:
      'Directory containing JS files to insert require statements for the CSS files',
    requiresArg: true,
  })
  .option('transform', {
    alias: 't',
    type: 'boolean',
    description: 'Replace template tags with evaluated values',
  })
  .option('modules', {
    alias: 'm',
    choices: modulesOptions,
    description: 'Specifies a type of used imports',
    default: 'commonjs' as const,
    coerce: (s) => s.toLowerCase(),
  })
  .implies('insert-css-requires', 'source-root')
  .implies('transform', 'insert-css-requires')
  .option('ignore', {
    alias: 'x',
    type: 'string',
    description: 'Pattern of files to ignore. Be sure to provide a string',
    requiresArg: true,
  })
  .alias('help', 'h')
  .alias('version', 'v')
  .parseSync();

type Options = {
  configFile?: string;
  ignore?: string;
  insertCssRequires?: string;
  modules: typeof modulesOptions[number];
  outDir: string;
  sourceMaps?: boolean;
  sourceRoot: string;
  transform?: boolean;
};

function resolveRequireInsertionFilename(filename: string) {
  return filename.replace(/\.tsx?/, '.js');
}

function resolveOutputFilename(
  filename: string,
  outDir: string,
  sourceRoot: string
) {
  const outputFolder = path.relative(sourceRoot, path.dirname(filename));
  const outputBasename = path
    .basename(filename)
    .replace(path.extname(filename), '.css');

  return path.join(outDir, outputFolder, outputBasename);
}

async function processFiles(files: (number | string)[], options: Options) {
  const startedAt = performance.now();
  let count = 0;

  const resolvedFiles = files.reduce(
    (acc, pattern) => [
      ...acc,
      ...glob.sync(pattern.toString(), {
        absolute: true,
        ignore: options.ignore,
      }),
    ],
    [] as string[]
  );

  const codeCache: CodeCache = new Map();
  const resolveCache = new Map<string, string>();
  const evalCache = new Map<string, Module>();

  const timings = new Map<string, number>();
  const addTiming = (key: string, value: number) => {
    timings.set(key, Math.round((timings.get(key) || 0) + value));
  };

  const startTimes = new Map<string, number>();
  const onEvent = (unknownEvent: unknown) => {
    const ev = unknownEvent as { type: string; filename: string };
    const [, stage, type] = ev.type.split(':');
    if (type === 'start') {
      startTimes.set(ev.filename, performance.now());
      startTimes.set(stage, performance.now());
    } else {
      const startTime = startTimes.get(ev.filename);
      if (startTime) {
        addTiming(ev.filename, performance.now() - startTime);
      }
      const stageStartTime = startTimes.get(stage);
      if (stageStartTime) {
        addTiming(stage, performance.now() - stageStartTime);
      }
    }
  };

  const modifiedFiles: { name: string; content: string }[] = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const filename of resolvedFiles) {
    if (fs.lstatSync(filename).isDirectory()) {
      return;
    }

    const outputFilename = resolveOutputFilename(
      filename,
      options.outDir,
      options.sourceRoot
    );

    // eslint-disable-next-line no-await-in-loop
    const { code, cssText, sourceMap, cssSourceMapText } = await transform(
      fs.readFileSync(filename).toString(),
      {
        filename,
        outputFilename,
        pluginOptions: {
          configFile: options.configFile,
        },
        root: options.sourceRoot,
      },
      asyncResolveFallback,
      {},
      resolveCache,
      codeCache,
      evalCache,
      onEvent
    );

    if (cssText) {
      mkdirp.sync(path.dirname(outputFilename));

      const cssContent =
        options.sourceMaps && sourceMap
          ? `${cssText}\n/*# sourceMappingURL=${outputFilename}.map */`
          : cssText;

      fs.writeFileSync(outputFilename, cssContent);

      if (
        options.sourceMaps &&
        sourceMap &&
        typeof cssSourceMapText !== 'undefined'
      ) {
        fs.writeFileSync(`${outputFilename}.map`, cssSourceMapText);
      }

      if (options.sourceRoot && options.insertCssRequires) {
        const inputFilename = path.resolve(
          options.insertCssRequires,
          path.relative(options.sourceRoot, filename)
        );

        const relativePath = normalize(
          path.relative(path.dirname(inputFilename), outputFilename)
        );

        const pathForImport = relativePath.startsWith('.')
          ? relativePath
          : `./${relativePath}`;

        const statement =
          options.modules === 'commonjs'
            ? `\nrequire('${pathForImport}');`
            : `\nimport "${pathForImport}";`;

        const normalizedInputFilename =
          resolveRequireInsertionFilename(inputFilename);

        const inputContent = options.transform
          ? code
          : fs.readFileSync(normalizedInputFilename, 'utf-8');

        if (!inputContent.trim().endsWith(statement)) {
          modifiedFiles.push({
            name: normalizedInputFilename,
            content: `${inputContent}\n${statement}\n`,
          });
        }
      }

      count += 1;
    }
  }

  modifiedFiles.forEach(({ name, content }) => {
    fs.writeFileSync(name, content);
  });

  console.log(`Successfully extracted ${count} CSS files.`);

  console.log(`\nTimings:`);
  console.log(`  Total: ${(performance.now() - startedAt).toFixed()}ms`);
  console.log(`\n  By stages:`);
  let stage = 1;
  while (timings.has(`stage-${stage}`)) {
    console.log(`    Stage ${stage}: ${timings.get(`stage-${stage}`)}ms`);
    timings.delete(`stage-${stage}`);
    stage += 1;
  }

  console.log('\n  By files:');

  const byFiles = Array.from(timings.entries());
  byFiles.sort(([, a], [, b]) => b - a);
  byFiles.forEach(([filename, time]) => {
    const relativeFilename = path.relative(
      options.sourceRoot ?? process.cwd(),
      filename
    );
    console.log(`    ${relativeFilename}: ${time}ms`);
  });
}

processFiles(argv._, {
  configFile: argv.config,
  ignore: argv.ignore,
  insertCssRequires: argv['insert-css-requires'],
  modules: argv.modules,
  outDir: argv['out-dir'],
  sourceMaps: argv['source-maps'],
  sourceRoot: argv['source-root'],
  transform: argv.transform,
});
