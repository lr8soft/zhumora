declare module 'xlsx-populate' {
  export interface XlsxPopulateCell {
    address(): string
    rowNumber(): number
    columnNumber(): number
    columnName(): string
    value(value: string | number | boolean | Date | null | undefined): XlsxPopulateCell
    value(): string | number | boolean | Date | null
    formula(formula: string): XlsxPopulateCell
    formula(): string
    relativeCell(row: number, col: number): XlsxPopulateCell
    type(): string
  }
  export interface XlsxPopulateRange {
    value(values: (string | number | boolean | Date | null)[][]): XlsxPopulateRange
    formula(formula: string): XlsxPopulateRange
    cell(row: number, col: number): XlsxPopulateCell
  }
  export interface XlsxPopulateSheet {
    name(name?: string): string | XlsxPopulateSheet
    cell(address: string, row?: number): XlsxPopulateCell
    range(address: string): XlsxPopulateRange
    delete(): XlsxPopulateSheet
  }
  export interface XlsxPopulateWorkbook {
    sheet(nameOrIndex: string | number): XlsxPopulateSheet
    addSheet(name: string, index?: number): XlsxPopulateSheet
    deleteSheet(nameOrIndex: string | number): XlsxPopulateWorkbook
    sheets(): XlsxPopulateSheet[]
    toFileAsync(filePath: string): Promise<void>
    toDataAsync(): Promise<Buffer>
  }
  const XlsxPopulate: {
    fromBlankAsync(): Promise<XlsxPopulateWorkbook>
    fromFileAsync(filePath: string): Promise<XlsxPopulateWorkbook>
    fromDataAsync(data: Buffer | ArrayBuffer): Promise<XlsxPopulateWorkbook>
  }
  export default XlsxPopulate
}
