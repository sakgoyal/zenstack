import type { DMMF } from '@prisma/generator-helper';
import { PluginError, getPrismaClientImportSpec } from '@zenstackhq/sdk';
import { Model } from '@zenstackhq/sdk/ast';
import { lowerCaseFirst } from 'lower-case-first';
import { CodeBlockWriter, SourceFile } from 'ts-morph';
import { upperCaseFirst } from 'upper-case-first';
import { name } from '.';

export function generateProcedure(
    writer: CodeBlockWriter,
    opType: string,
    typeName: string,
    modelName: string,
    baseOpType: string
) {
    const procType = getProcedureTypeByOpName(baseOpType);
    const prismaMethod = opType.replace('One', '');

    if (procType === 'query') {
        // the cast "as any" is to circumvent a TS compiler misfired error in certain cases
        writer.write(`
        ${opType}: procedure.input(${typeName}).query(({ctx, input}) => checkRead(db(ctx).${lowerCaseFirst(
            modelName
        )}.${prismaMethod}(input as any))),
    `);
    } else if (procType === 'mutation') {
        // the cast "as any" is to circumvent a TS compiler misfired error in certain cases
        writer.write(`
        ${opType}: procedure.input(${typeName}).mutation(async ({ctx, input}) => checkMutate(db(ctx).${lowerCaseFirst(
            modelName
        )}.${prismaMethod}(input as any))),
    `);
    }
}

/**
 * Given a model and Prisma operation, returns related TS types.
 */
function getPrismaOperationTypes(model: string, operation: string) {
    // TODO: find a way to derive from Prisma Client API's generic types
    // instead of duplicating them

    const capModel = upperCaseFirst(model);
    const capOperation = upperCaseFirst(operation);

    let genericBase = `Prisma.${capModel}${capOperation}Args`;
    const getPayload = `Prisma.${capModel}GetPayload<T>`;
    const selectSubset = `Prisma.SelectSubset<T, ${genericBase}>`;

    let argsType: string;
    let resultType: string;

    switch (operation) {
        case 'findUnique':
        case 'findUniqueOrThrow':
        case 'findFirst':
        case 'findFirstOrThrow':
            argsType = selectSubset;
            resultType = getPayload;
            break;

        case 'findMany':
            argsType = selectSubset;
            resultType = `Array<${getPayload}>`;
            break;

        case 'create':
            argsType = selectSubset;
            resultType = getPayload;
            break;

        case 'createMany':
            argsType = selectSubset;
            resultType = `Prisma.BatchPayload`;
            break;

        case 'update':
            argsType = selectSubset;
            resultType = getPayload;
            break;

        case 'updateMany':
            argsType = selectSubset;
            resultType = `Prisma.BatchPayload`;
            break;

        case 'upsert':
            argsType = selectSubset;
            resultType = getPayload;
            break;

        case 'delete':
            argsType = selectSubset;
            resultType = getPayload;
            break;

        case 'deleteMany':
            argsType = selectSubset;
            resultType = `Prisma.BatchPayload`;
            break;

        case 'count':
            argsType = `Prisma.Subset<T, ${genericBase}>`;
            resultType = `'select' extends keyof T
            ? T['select'] extends true
              ? number
              : Prisma.GetScalarType<T['select'], Prisma.${capModel}CountAggregateOutputType>
            : number`;
            break;

        case 'aggregate':
            argsType = `Prisma.Subset<T, ${genericBase}>`;
            resultType = `Prisma.Get${capModel}AggregateType<T>`;
            break;

        case 'groupBy':
            genericBase = `Prisma.${capModel}GroupByArgs,
            HasSelectOrTake extends Prisma.Or<
              Prisma.Extends<'skip', Prisma.Keys<T>>,
              Prisma.Extends<'take', Prisma.Keys<T>>
            >,
            OrderByArg extends Prisma.True extends HasSelectOrTake
              ? { orderBy: Prisma.${capModel}GroupByArgs['orderBy'] }
              : { orderBy?: Prisma.${capModel}GroupByArgs['orderBy'] },
            OrderFields extends Prisma.ExcludeUnderscoreKeys<Prisma.Keys<Prisma.MaybeTupleToUnion<T['orderBy']>>>,
            ByFields extends Prisma.MaybeTupleToUnion<T['by']>,
            ByValid extends Prisma.Has<ByFields, OrderFields>,
            HavingFields extends Prisma.GetHavingFields<T['having']>,
            HavingValid extends Prisma.Has<ByFields, HavingFields>,
            ByEmpty extends T['by'] extends never[] ? Prisma.True : Prisma.False,
            InputErrors extends ByEmpty extends Prisma.True
            ? \`Error: "by" must not be empty.\`
            : HavingValid extends Prisma.False
            ? {
                [P in HavingFields]: P extends ByFields
                  ? never
                  : P extends string
                  ? \`Error: Field "\${P}" used in "having" needs to be provided in "by".\`
                  : [
                      Error,
                      'Field ',
                      P,
                      \` in "having" needs to be provided in "by"\`,
                    ]
              }[HavingFields]
            : 'take' extends Prisma.Keys<T>
            ? 'orderBy' extends Prisma.Keys<T>
              ? ByValid extends Prisma.True
                ? {}
                : {
                    [P in OrderFields]: P extends ByFields
                      ? never
                      : \`Error: Field "\${P}" in "orderBy" needs to be provided in "by"\`
                  }[OrderFields]
              : 'Error: If you provide "take", you also need to provide "orderBy"'
            : 'skip' extends Prisma.Keys<T>
            ? 'orderBy' extends Prisma.Keys<T>
              ? ByValid extends Prisma.True
                ? {}
                : {
                    [P in OrderFields]: P extends ByFields
                      ? never
                      : \`Error: Field "\${P}" in "orderBy" needs to be provided in "by"\`
                  }[OrderFields]
              : 'Error: If you provide "skip", you also need to provide "orderBy"'
            : ByValid extends Prisma.True
            ? {}
            : {
                [P in OrderFields]: P extends ByFields
                  ? never
                  : \`Error: Field "\${P}" in "orderBy" needs to be provided in "by"\`
              }[OrderFields]
          `;
            argsType = `Prisma.SubsetIntersection<T, Prisma.${capModel}GroupByArgs, OrderByArg> & InputErrors`;
            resultType = `{} extends InputErrors ? Prisma.Get${capModel}GroupByPayload<T> : InputErrors`;
            break;

        default:
            throw new PluginError(name, `Unsupported operation: "${operation}"`);
    }

    return { genericBase, argsType, resultType };
}

/**
 * Generate precise Prisma-like typing for router procedures.
 */
export function generateRouterTyping(writer: CodeBlockWriter, opType: string, modelName: string, baseOpType: string) {
    const procType = getProcedureTypeByOpName(baseOpType);
    const { genericBase, argsType, resultType } = getPrismaOperationTypes(modelName, opType);
    const errorType = `TRPCClientErrorLike<AppRouter>`;

    writer.block(() => {
        if (procType === 'query') {
            writer.writeLine(`
                useQuery: <T extends ${genericBase}, TData = ${resultType}>(
                    input: ${argsType},
                    opts?: UseTRPCQueryOptions<string, T, ${resultType}, TData, Error>
                    ) => UseTRPCQueryResult<
                        TData,
                        ${errorType}
                    >;
                useInfiniteQuery: <T extends ${genericBase}>(
                    input: Omit<${argsType}, 'cursor'>,
                    opts?: UseTRPCInfiniteQueryOptions<string, T, ${resultType}, Error>
                    ) => UseTRPCInfiniteQueryResult<
                        ${resultType},
                        ${errorType}
                    >;
                    `);
        } else if (procType === 'mutation') {
            writer.writeLine(`
                useMutation: <T extends ${genericBase}>(opts?: UseTRPCMutationOptions<
                    ${genericBase},
                    ${errorType},
                    ${resultType},
                    Context
                >,) =>
                Omit<UseTRPCMutationResult<${resultType}, ${errorType}, ${argsType}, Context>, 'mutateAsync'> & {
                    mutateAsync:
                        <T extends ${genericBase}>(variables: T, opts?: UseTRPCMutationOptions<T, ${errorType}, ${resultType}, Context>) => Promise<${resultType}>
                };
                `);
        }
    });
}

export function generateRouterTypingImports(sourceFile: SourceFile, model: Model) {
    const importingDir = sourceFile.getDirectoryPath();
    const prismaImport = getPrismaClientImportSpec(model, importingDir);
    sourceFile.addStatements([
        `import type { Prisma } from '${prismaImport}';`,
        `import type { UseTRPCMutationOptions, UseTRPCMutationResult, UseTRPCQueryOptions, UseTRPCQueryResult, UseTRPCInfiniteQueryOptions, UseTRPCInfiniteQueryResult } from '@trpc/react-query/shared';`,
        `import type { TRPCClientErrorLike } from '@trpc/client';`,
        `import type { AnyRouter } from '@trpc/server';`,
    ]);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function generateRouterSchemaImport(sourceFile: SourceFile, zodSchemasImport: string) {
    sourceFile.addStatements(`import * as $Schema from '${zodSchemasImport}/input';`);
}

export function generateHelperImport(sourceFile: SourceFile) {
    sourceFile.addStatements(`import { checkRead, checkMutate } from '../helper';`);
}

export const getInputSchemaByOpName = (opName: string, modelName: string) => {
    let inputType;
    const capModelName = upperCaseFirst(modelName);
    switch (opName) {
        case 'findUnique':
            inputType = `$Schema.${capModelName}InputSchema.findUnique`;
            break;
        case 'findFirst':
            inputType = `$Schema.${capModelName}InputSchema.findFirst`;
            break;
        case 'findMany':
            inputType = `$Schema.${capModelName}InputSchema.findMany`;
            break;
        case 'findRaw':
            inputType = `$Schema.${capModelName}InputSchema.findRawObject`;
            break;
        case 'createOne':
            inputType = `$Schema.${capModelName}InputSchema.create`;
            break;
        case 'createMany':
            inputType = `$Schema.${capModelName}InputSchema.createMany`;
            break;
        case 'deleteOne':
            inputType = `$Schema.${capModelName}InputSchema.delete`;
            break;
        case 'updateOne':
            inputType = `$Schema.${capModelName}InputSchema.update`;
            break;
        case 'deleteMany':
            inputType = `$Schema.${capModelName}InputSchema.deleteMany`;
            break;
        case 'updateMany':
            inputType = `$Schema.${capModelName}InputSchema.updateMany`;
            break;
        case 'upsertOne':
            inputType = `$Schema.${capModelName}InputSchema.upsert`;
            break;
        case 'aggregate':
            inputType = `$Schema.${capModelName}InputSchema.aggregate`;
            break;
        case 'aggregateRaw':
            inputType = `$Schema.${capModelName}InputSchema.aggregateRawObject`;
            break;
        case 'groupBy':
            inputType = `$Schema.${capModelName}InputSchema.groupBy`;
            break;
        case 'count':
            inputType = `$Schema.${capModelName}InputSchema.count`;
            break;
        default:
            break;
    }
    return inputType;
};

export const getProcedureTypeByOpName = (opName: string) => {
    let procType;
    switch (opName) {
        case 'findUnique':
        case 'findFirst':
        case 'findMany':
        case 'findRaw':
        case 'aggregate':
        case 'aggregateRaw':
        case 'groupBy':
        case 'count':
            procType = 'query';
            break;
        case 'createOne':
        case 'createMany':
        case 'deleteOne':
        case 'updateOne':
        case 'deleteMany':
        case 'updateMany':
        case 'upsertOne':
            procType = 'mutation';
            break;
        default:
            console.log('getProcedureTypeByOpName: ', { opName });
    }
    return procType;
};

export function resolveModelsComments(models: DMMF.Model[], hiddenModels: string[]) {
    const modelAttributeRegex = /(@@Gen\.)+([A-z])+(\()+(.+)+(\))+/;
    const attributeNameRegex = /(?:\.)+([A-Za-z])+(?:\()+/;
    const attributeArgsRegex = /(?:\()+([A-Za-z])+:+(.+)+(?:\))+/;

    for (const model of models) {
        if (model.documentation) {
            const attribute = model.documentation?.match(modelAttributeRegex)?.[0];
            const attributeName = attribute?.match(attributeNameRegex)?.[0]?.slice(1, -1);
            if (attributeName !== 'model') continue;
            const rawAttributeArgs = attribute?.match(attributeArgsRegex)?.[0]?.slice(1, -1);

            const parsedAttributeArgs: Record<string, unknown> = {};
            if (rawAttributeArgs) {
                const rawAttributeArgsParts = rawAttributeArgs
                    .split(':')
                    .map((it) => it.trim())
                    .map((part) => (part.startsWith('[') ? part : part.split(',')))
                    .flat()
                    .map((it) => it.trim());

                for (let i = 0; i < rawAttributeArgsParts.length; i += 2) {
                    const key = rawAttributeArgsParts[i];
                    const value = rawAttributeArgsParts[i + 1];
                    parsedAttributeArgs[key] = JSON.parse(value);
                }
            }
            if (parsedAttributeArgs.hide) {
                hiddenModels.push(model.name);
            }
        }
    }
}
