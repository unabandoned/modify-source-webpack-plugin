import path from 'path';
import type { LoaderContext } from 'webpack';

import { Operation, SerializableOperation } from './operations';

const schema = {
  type: 'object' as const,
  properties: {
    operations: {
      type: 'array' as const,
      items: {
        type: 'object' as const
      }
    },
    moduleRequest: {
      type: 'string' as const
    },
    constants: {
      type: 'object' as const
    }
  },
  additionalProperties: false
};

interface LoaderOptions {
  operations: SerializableOperation[];
  moduleRequest: string;
  constants: Record<string, string>;
}

export default function modifyModuleSourceLoader(
  this: LoaderContext<LoaderOptions>,
  source: string
): string {
  // webpack 5 validates the options against the schema itself.
  const options = this.getOptions(schema);

  const cleanPath = options.moduleRequest.split('?')[0];
  const fileName = path.basename(cleanPath);

  return options.operations.reduce((sourceText, serializableOp) => {
    const operation = Operation.fillConstants(
      Operation.fromSerializable(serializableOp),
      {
        ...options.constants,
        FILE_PATH: cleanPath,
        FILE_NAME: fileName
      }
    );

    return Operation.apply(sourceText, operation);
  }, source);
}
