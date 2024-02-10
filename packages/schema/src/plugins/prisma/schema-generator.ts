import {
    AttributeArg,
    BooleanLiteral,
    ConfigArrayExpr,
    ConfigExpr,
    ConfigInvocationArg,
    DataModel,
    DataModelAttribute,
    DataModelField,
    DataModelFieldAttribute,
    DataModelFieldType,
    DataSource,
    Enum,
    EnumField,
    Expression,
    GeneratorDecl,
    InvocationExpr,
    isArrayExpr,
    isInvocationExpr,
    isLiteralExpr,
    isNullExpr,
    isReferenceExpr,
    isStringLiteral,
    LiteralExpr,
    Model,
    NumberLiteral,
    StringLiteral,
} from '@zenstackhq/language/ast';
import { match } from 'ts-pattern';

import { PRISMA_MINIMUM_VERSION } from '@zenstackhq/runtime';
import {
    getAttribute,
    getDMMF,
    getLiteral,
    getPrismaVersion,
    isAuthInvocation,
    PluginError,
    PluginOptions,
    resolved,
    resolvePath,
    ZModelCodeGenerator,
} from '@zenstackhq/sdk';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import { streamAst } from 'langium';
import path from 'path';
import semver from 'semver';
import stripColor from 'strip-color';
import { name } from '.';
import { getStringLiteral } from '../../language-server/validator/utils';
import telemetry from '../../telemetry';
import { execSync } from '../../utils/exec-utils';
import { findPackageJson } from '../../utils/pkg-utils';
import {
    ModelFieldType,
    AttributeArg as PrismaAttributeArg,
    AttributeArgValue as PrismaAttributeArgValue,
    ContainerDeclaration as PrismaContainerDeclaration,
    Model as PrismaDataModel,
    Enum as PrismaEnum,
    FieldAttribute as PrismaFieldAttribute,
    FieldReference as PrismaFieldReference,
    FieldReferenceArg as PrismaFieldReferenceArg,
    FunctionCall as PrismaFunctionCall,
    FunctionCallArg as PrismaFunctionCallArg,
    PrismaModel,
    ContainerAttribute as PrismaModelAttribute,
    PassThroughAttribute as PrismaPassThroughAttribute,
    SimpleField,
} from './prisma-builder';

const MODEL_PASSTHROUGH_ATTR = '@@prisma.passthrough';
const FIELD_PASSTHROUGH_ATTR = '@prisma.passthrough';

/**
 * Generates Prisma schema file
 */
export default class PrismaSchemaGenerator {
    private zModelGenerator: ZModelCodeGenerator = new ZModelCodeGenerator();

    private readonly PRELUDE = `//////////////////////////////////////////////////////////////////////////////////////////////
// DO NOT MODIFY THIS FILE                                                                  //
// This file is automatically generated by ZenStack CLI and should not be manually updated. //
//////////////////////////////////////////////////////////////////////////////////////////////

`;

    async generate(model: Model, options: PluginOptions) {
        const warnings: string[] = [];

        const prismaVersion = getPrismaVersion();
        if (prismaVersion && semver.lt(prismaVersion, PRISMA_MINIMUM_VERSION)) {
            warnings.push(
                `ZenStack requires Prisma version "${PRISMA_MINIMUM_VERSION}" or higher. Detected version is "${prismaVersion}".`
            );
        }

        const prisma = new PrismaModel();

        for (const decl of model.declarations) {
            switch (decl.$type) {
                case DataSource:
                    this.generateDataSource(prisma, decl as DataSource);
                    break;

                case Enum:
                    this.generateEnum(prisma, decl as Enum);
                    break;

                case DataModel:
                    this.generateModel(prisma, decl as DataModel);
                    break;

                case GeneratorDecl:
                    this.generateGenerator(prisma, decl as GeneratorDecl);
                    break;
            }
        }

        const outFile = options.output
            ? resolvePath(options.output as string, options)
            : getDefaultPrismaOutputFile(options.schemaPath);

        if (!fs.existsSync(path.dirname(outFile))) {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
        }
        await writeFile(outFile, this.PRELUDE + prisma.toString());

        if (options.format === true) {
            try {
                // run 'prisma format'
                await execSync(`npx prisma format --schema ${outFile}`);
            } catch {
                warnings.push(`Failed to format Prisma schema file`);
            }
        }

        const generateClient = options.generateClient !== false;

        if (generateClient) {
            let generateCmd = `npx prisma generate --schema "${outFile}"`;
            if (typeof options.generateArgs === 'string') {
                generateCmd += ` ${options.generateArgs}`;
            }
            try {
                // run 'prisma generate'
                await execSync(generateCmd, { stdio: 'ignore' });
            } catch {
                await this.trackPrismaSchemaError(outFile);
                try {
                    // run 'prisma generate' again with output to the console
                    await execSync(generateCmd);
                } catch {
                    // noop
                }
                throw new PluginError(name, `Failed to run "prisma generate"`);
            }
        }

        return warnings;
    }

    private async trackPrismaSchemaError(schema: string) {
        try {
            await getDMMF({ datamodel: fs.readFileSync(schema, 'utf-8') });
        } catch (err) {
            if (err instanceof Error) {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                telemetry.track('prisma:error', { command: 'generate', message: stripColor(err.message) });
            }
        }
    }

    private generateDataSource(prisma: PrismaModel, dataSource: DataSource) {
        const fields: SimpleField[] = dataSource.fields.map((f) => ({
            name: f.name,
            text: this.configExprToText(f.value),
        }));
        prisma.addDataSource(dataSource.name, fields);
    }

    private configExprToText(expr: ConfigExpr) {
        if (isLiteralExpr(expr)) {
            return this.literalToText(expr);
        } else if (isInvocationExpr(expr)) {
            const fc = this.makeFunctionCall(expr);
            return fc.toString();
        } else {
            return this.configArrayToText(expr);
        }
    }

    private configArrayToText(expr: ConfigArrayExpr) {
        return (
            '[' +
            expr.items
                .map((item) => {
                    if (isLiteralExpr(item)) {
                        return this.literalToText(item);
                    } else {
                        return (
                            item.name +
                            (item.args.length > 0
                                ? '(' + item.args.map((arg) => this.configInvocationArgToText(arg)).join(', ') + ')'
                                : '')
                        );
                    }
                })
                .join(', ') +
            ']'
        );
    }

    private configInvocationArgToText(arg: ConfigInvocationArg) {
        return `${arg.name}: ${this.literalToText(arg.value)}`;
    }

    private literalToText(expr: LiteralExpr) {
        return JSON.stringify(expr.value);
    }

    private generateGenerator(prisma: PrismaModel, decl: GeneratorDecl) {
        const generator = prisma.addGenerator(
            decl.name,
            decl.fields.map((f) => ({ name: f.name, text: this.configExprToText(f.value) }))
        );

        // deal with configuring PrismaClient preview features
        const provider = generator.fields.find((f) => f.name === 'provider');
        if (provider?.text === JSON.stringify('prisma-client-js')) {
            const prismaVersion = getPrismaVersion();
            if (prismaVersion) {
                const previewFeatures = JSON.parse(
                    generator.fields.find((f) => f.name === 'previewFeatures')?.text ?? '[]'
                );

                if (!Array.isArray(previewFeatures)) {
                    throw new PluginError(name, 'option "previewFeatures" must be an array');
                }

                if (semver.lt(prismaVersion, '5.0.0')) {
                    // extendedWhereUnique feature is opt-in pre V5
                    if (!previewFeatures.includes('extendedWhereUnique')) {
                        previewFeatures.push('extendedWhereUnique');
                    }
                }

                if (semver.lt(prismaVersion, '5.0.0')) {
                    // fieldReference feature is opt-in pre V5
                    if (!previewFeatures.includes('fieldReference')) {
                        previewFeatures.push('fieldReference');
                    }
                }

                if (previewFeatures.length > 0) {
                    const curr = generator.fields.find((f) => f.name === 'previewFeatures');
                    if (!curr) {
                        generator.fields.push({ name: 'previewFeatures', text: JSON.stringify(previewFeatures) });
                    } else {
                        curr.text = JSON.stringify(previewFeatures);
                    }
                }
            }
        }
    }

    private generateModel(prisma: PrismaModel, decl: DataModel) {
        const model = decl.isView ? prisma.addView(decl.name) : prisma.addModel(decl.name);
        for (const field of decl.fields) {
            this.generateModelField(model, field);
        }

        for (const attr of decl.attributes.filter((attr) => this.isPrismaAttribute(attr))) {
            this.generateContainerAttribute(model, attr);
        }

        decl.attributes
            .filter((attr) => attr.decl.ref && !this.isPrismaAttribute(attr))
            .forEach((attr) => model.addComment('/// ' + this.zModelGenerator.generate(attr)));

        // user defined comments pass-through
        decl.comments.forEach((c) => model.addComment(c));
    }

    private isPrismaAttribute(attr: DataModelAttribute | DataModelFieldAttribute) {
        if (!attr.decl.ref) {
            return false;
        }
        const attrDecl = resolved(attr.decl);
        return (
            !!attrDecl.attributes.find((a) => a.decl.ref?.name === '@@@prisma') ||
            // the special pass-through attribute
            attrDecl.name === MODEL_PASSTHROUGH_ATTR ||
            attrDecl.name === FIELD_PASSTHROUGH_ATTR
        );
    }

    private getUnsupportedFieldType(fieldType: DataModelFieldType) {
        if (fieldType.unsupported) {
            const value = getStringLiteral(fieldType.unsupported.value);
            if (value) {
                return `Unsupported("${value}")`;
            } else {
                return undefined;
            }
        } else {
            return undefined;
        }
    }

    private generateModelField(model: PrismaDataModel, field: DataModelField) {
        const fieldType =
            field.type.type || field.type.reference?.ref?.name || this.getUnsupportedFieldType(field.type);
        if (!fieldType) {
            throw new PluginError(name, `Field type is not resolved: ${field.$container.name}.${field.name}`);
        }

        const type = new ModelFieldType(fieldType, field.type.array, field.type.optional);

        const attributes = this.getAttributesToGenerate(field);

        const nonPrismaAttributes = field.attributes.filter((attr) => attr.decl.ref && !this.isPrismaAttribute(attr));

        const documentations = nonPrismaAttributes.map((attr) => '/// ' + this.zModelGenerator.generate(attr));

        const result = model.addField(field.name, type, attributes, documentations);

        // user defined comments pass-through
        field.comments.forEach((c) => result.addComment(c));
    }

    private getAttributesToGenerate(field: DataModelField) {
        if (this.hasDefaultWithAuth(field)) {
            return [];
        }
        return field.attributes
            .filter((attr) => this.isPrismaAttribute(attr))
            .map((attr) => this.makeFieldAttribute(attr));
    }

    private hasDefaultWithAuth(field: DataModelField) {
        const defaultAttr = getAttribute(field, '@default');
        if (!defaultAttr) {
            return false;
        }

        const expr = defaultAttr.args[0]?.value;
        if (!expr) {
            return false;
        }

        // find `auth()` in default value expression
        return streamAst(expr).some(isAuthInvocation);
    }

    private makeFieldAttribute(attr: DataModelFieldAttribute) {
        const attrName = resolved(attr.decl).name;
        if (attrName === FIELD_PASSTHROUGH_ATTR) {
            const text = getLiteral<string>(attr.args[0].value);
            if (text) {
                return new PrismaPassThroughAttribute(text);
            } else {
                throw new PluginError(name, `Invalid arguments for ${FIELD_PASSTHROUGH_ATTR} attribute`);
            }
        } else {
            return new PrismaFieldAttribute(
                attrName,
                attr.args.map((arg) => this.makeAttributeArg(arg))
            );
        }
    }

    private makeAttributeArg(arg: AttributeArg): PrismaAttributeArg {
        return new PrismaAttributeArg(arg.name, this.makeAttributeArgValue(arg.value));
    }

    private makeAttributeArgValue(node: Expression): PrismaAttributeArgValue {
        if (isLiteralExpr(node)) {
            const argType = match(node.$type)
                .with(StringLiteral, () => 'String' as const)
                .with(NumberLiteral, () => 'Number' as const)
                .with(BooleanLiteral, () => 'Boolean' as const)
                .exhaustive();
            return new PrismaAttributeArgValue(argType, node.value);
        } else if (isArrayExpr(node)) {
            return new PrismaAttributeArgValue(
                'Array',
                new Array(...node.items.map((item) => this.makeAttributeArgValue(item)))
            );
        } else if (isReferenceExpr(node)) {
            return new PrismaAttributeArgValue(
                'FieldReference',
                new PrismaFieldReference(
                    resolved(node.target).name,
                    node.args.map((arg) => new PrismaFieldReferenceArg(arg.name, arg.value))
                )
            );
        } else if (isInvocationExpr(node)) {
            // invocation
            return new PrismaAttributeArgValue('FunctionCall', this.makeFunctionCall(node));
        } else {
            throw new PluginError(name, `Unsupported attribute argument expression type: ${node.$type}`);
        }
    }

    makeFunctionCall(node: InvocationExpr): PrismaFunctionCall {
        return new PrismaFunctionCall(
            resolved(node.function).name,
            node.args.map((arg) => {
                const val = match(arg.value)
                    .when(isStringLiteral, (v) => `"${v.value}"`)
                    .when(isLiteralExpr, (v) => v.value.toString())
                    .when(isNullExpr, () => 'null')
                    .otherwise(() => {
                        throw new PluginError(name, 'Function call argument must be literal or null');
                    });

                return new PrismaFunctionCallArg(arg.name, val);
            })
        );
    }

    private generateContainerAttribute(container: PrismaContainerDeclaration, attr: DataModelAttribute) {
        const attrName = resolved(attr.decl).name;
        if (attrName === MODEL_PASSTHROUGH_ATTR) {
            const text = getLiteral<string>(attr.args[0].value);
            if (text) {
                container.attributes.push(new PrismaPassThroughAttribute(text));
            }
        } else {
            container.attributes.push(
                new PrismaModelAttribute(
                    attrName,
                    attr.args.map((arg) => this.makeAttributeArg(arg))
                )
            );
        }
    }

    private generateEnum(prisma: PrismaModel, decl: Enum) {
        const _enum = prisma.addEnum(decl.name);

        for (const field of decl.fields) {
            this.generateEnumField(_enum, field);
        }

        for (const attr of decl.attributes.filter((attr) => this.isPrismaAttribute(attr))) {
            this.generateContainerAttribute(_enum, attr);
        }

        decl.attributes
            .filter((attr) => attr.decl.ref && !this.isPrismaAttribute(attr))
            .forEach((attr) => _enum.addComment('/// ' + this.zModelGenerator.generate(attr)));

        // user defined comments pass-through
        decl.comments.forEach((c) => _enum.addComment(c));
    }

    private generateEnumField(_enum: PrismaEnum, field: EnumField) {
        const attributes = field.attributes
            .filter((attr) => this.isPrismaAttribute(attr))
            .map((attr) => this.makeFieldAttribute(attr));

        const nonPrismaAttributes = field.attributes.filter((attr) => attr.decl.ref && !this.isPrismaAttribute(attr));

        const documentations = nonPrismaAttributes.map((attr) => '/// ' + this.zModelGenerator.generate(attr));
        _enum.addField(field.name, attributes, documentations);
    }
}

export function getDefaultPrismaOutputFile(schemaPath: string) {
    // handle override from package.json
    const pkgJsonPath = findPackageJson(path.dirname(schemaPath));
    if (pkgJsonPath) {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (typeof pkgJson?.zenstack?.prisma === 'string') {
            if (path.isAbsolute(pkgJson.zenstack.prisma)) {
                return pkgJson.zenstack.prisma;
            } else {
                // resolve relative to package.json
                return path.resolve(path.dirname(pkgJsonPath), pkgJson.zenstack.prisma);
            }
        }
    }

    return resolvePath('./prisma/schema.prisma', { schemaPath });
}
