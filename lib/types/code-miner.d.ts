export interface EnumValue {
    name: string;
    code?: string;
    label?: string;
    line: number;
}
export interface EnumCandidate {
    name: string;
    module: string;
    file: string;
    line: number;
    values: EnumValue[];
    kind: 'enum' | 'constants';
    hash: string;
}
export interface ModuleOutline {
    module: string;
    fileCount: number;
    enumEstimate: number;
}
export interface MineResult {
    enums: EnumCandidate[];
    modules: string[];
    outline: ModuleOutline[];
}
/** 解析单文件，返回候选（可能 0 个）。 */
export declare function parseJavaFile(relPath: string, text: string): EnumCandidate[];
export declare function mineEnums(root: string, moduleFilter?: string): MineResult;
export interface TableColumn {
    name: string;
    type: string;
    nullable: boolean;
    comment?: string;
    primaryKey: boolean;
    line: number;
}
export interface TableIndex {
    name: string;
    columns: string[];
    unique: boolean;
    line: number;
}
export interface TableRelation {
    from: string;
    toTable: string;
    toColumn: string;
    line: number;
}
export interface TableCandidate {
    table: string;
    module: string;
    file: string;
    line: number;
    columns: TableColumn[];
    indexes: TableIndex[];
    relations: TableRelation[];
    comment?: string;
    hash: string;
    sources: string[];
}
export interface TableModuleOutline {
    module: string;
    fileCount: number;
    tableEstimate: number;
}
export interface TableMineResult {
    tables: TableCandidate[];
    modules: string[];
    outline: TableModuleOutline[];
}
/** 解析 SQL DDL 文件：CREATE TABLE / 索引 / 外键。 */
export declare function parseDdlFile(relPath: string, text: string): TableCandidate[];
/** 解析 MyBatis mapper XML：sql 片段列清单 + from/join/into 表引用。 */
export declare function parseMapperXml(relPath: string, text: string): TableCandidate[];
/** 解析 JPA @Entity：@Table/@Column/@Id。 */
export declare function parseJpaEntity(relPath: string, text: string): TableCandidate[];
/** 多来源合并：同表高优先级来源的列/索引/关系替换低优先级；sources 并集。 */
export declare function mergeTables(candidates: TableCandidate[]): TableCandidate[];
/** 挖掘全部表（DDL + mapper + JPA 三来源合并）。 */
export declare function mineTables(root: string, moduleFilter?: string): TableMineResult;
