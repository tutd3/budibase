import { InternalTables } from "../../../../db/utils"
import * as userController from "../../user"
import { FieldTypes } from "../../../../constants"
import { context } from "@budibase/backend-core"
import {
  Ctx,
  FieldType,
  RelationshipsJson,
  Row,
  Table,
  UserCtx,
} from "@budibase/types"
import sdk from "../../../../sdk"
import {
  processDates,
  processFormulas,
} from "../../../../utilities/rowProcessor"
import {
  squashRelationshipColumns,
  updateRelationshipColumns,
} from "./sqlUtils"
import { basicProcessing, generateIdForRow, fixArrayTypes } from "./basic"

import validateJs from "validate.js"
import { cloneDeep } from "lodash/fp"

function isForeignKey(key: string, table: Table) {
  const relationships = Object.values(table.schema).filter(
    column => column.type === FieldType.LINK
  )
  return relationships.some(relationship => relationship.foreignKey === key)
}

validateJs.extend(validateJs.validators.datetime, {
  parse: function (value: string) {
    return new Date(value).getTime()
  },
  // Input is a unix timestamp
  format: function (value: string) {
    return new Date(value).toISOString()
  },
})

export async function findRow(ctx: UserCtx, tableId: string, rowId: string) {
  const db = context.getAppDB()
  let row
  // TODO remove special user case in future
  if (tableId === InternalTables.USER_METADATA) {
    ctx.params = {
      id: rowId,
    }
    await userController.findMetadata(ctx)
    row = ctx.body
  } else {
    row = await db.get(rowId)
  }
  if (row.tableId !== tableId) {
    throw "Supplied tableId does not match the rows tableId"
  }
  return row
}

export function getTableId(ctx: Ctx) {
  if (ctx.request.body && ctx.request.body.tableId) {
    return ctx.request.body.tableId
  }
  if (ctx.params && ctx.params.tableId) {
    return ctx.params.tableId
  }
  if (ctx.params && ctx.params.viewName) {
    return ctx.params.viewName
  }
}

export async function validate({
  tableId,
  row,
  table,
}: {
  tableId?: string
  row: Row
  table?: Table
}) {
  let fetchedTable: Table
  if (!table) {
    fetchedTable = await sdk.tables.getTable(tableId)
  } else {
    fetchedTable = table
  }
  const errors: any = {}
  for (let fieldName of Object.keys(fetchedTable.schema)) {
    const column = fetchedTable.schema[fieldName]
    const constraints = cloneDeep(column.constraints)
    const type = column.type
    // foreign keys are likely to be enriched
    if (isForeignKey(fieldName, fetchedTable)) {
      continue
    }
    // formulas shouldn't validated, data will be deleted anyway
    if (type === FieldTypes.FORMULA || column.autocolumn) {
      continue
    }
    // special case for options, need to always allow unselected (empty)
    if (type === FieldTypes.OPTIONS && constraints?.inclusion) {
      constraints.inclusion.push(null as any, "")
    }
    let res

    // Validate.js doesn't seem to handle array
    if (type === FieldTypes.ARRAY && row[fieldName]) {
      if (row[fieldName].length) {
        if (!Array.isArray(row[fieldName])) {
          row[fieldName] = row[fieldName].split(",")
        }
        row[fieldName].map((val: any) => {
          if (
            !constraints?.inclusion?.includes(val) &&
            constraints?.inclusion?.length !== 0
          ) {
            errors[fieldName] = "Field not in list"
          }
        })
      } else if (constraints?.presence && row[fieldName].length === 0) {
        // non required MultiSelect creates an empty array, which should not throw errors
        errors[fieldName] = [`${fieldName} is required`]
      }
    } else if (
      (type === FieldTypes.ATTACHMENT || type === FieldTypes.JSON) &&
      typeof row[fieldName] === "string"
    ) {
      // this should only happen if there is an error
      try {
        const json = JSON.parse(row[fieldName])
        if (type === FieldTypes.ATTACHMENT) {
          if (Array.isArray(json)) {
            row[fieldName] = json
          } else {
            errors[fieldName] = [`Must be an array`]
          }
        }
      } catch (err) {
        errors[fieldName] = [`Contains invalid JSON`]
      }
    } else {
      res = validateJs.single(row[fieldName], constraints)
    }
    if (res) errors[fieldName] = res
  }
  return { valid: Object.keys(errors).length === 0, errors }
}

export function sqlOutputProcessing(
  rows: Row[] = [],
  table: Table,
  tables: Record<string, Table>,
  relationships: RelationshipsJson[],
  opts?: { internal?: boolean }
) {
  if (!rows || rows.length === 0 || rows[0].read === true) {
    return []
  }
  let finalRows: { [key: string]: Row } = {}
  for (let row of rows) {
    let rowId = row._id
    if (!rowId) {
      rowId = generateIdForRow(row, table)
      row._id = rowId
    }
    // this is a relationship of some sort
    if (finalRows[rowId]) {
      finalRows = updateRelationshipColumns(
        table,
        tables,
        row,
        finalRows,
        relationships
      )
      continue
    }
    const thisRow = fixArrayTypes(
      basicProcessing({
        row,
        table,
        isLinked: false,
        internal: opts?.internal,
      }),
      table
    )
    if (thisRow._id == null) {
      throw "Unable to generate row ID for SQL rows"
    }
    finalRows[thisRow._id] = thisRow
    // do this at end once its been added to the final rows
    finalRows = updateRelationshipColumns(
      table,
      tables,
      row,
      finalRows,
      relationships,
      opts
    )
  }

  // Process some additional data types
  let finalRowArray = Object.values(finalRows)
  finalRowArray = processDates(table, finalRowArray)
  finalRowArray = processFormulas(table, finalRowArray) as Row[]

  return finalRowArray.map((row: Row) =>
    squashRelationshipColumns(table, tables, row, relationships)
  )
}