import { cache } from "@budibase/backend-core"
import { utils } from "@budibase/shared-core"
import { Document, FieldSubtype } from "@budibase/types"
import { InvalidBBRefError } from "./errors"

export async function processInputBBReferences(
  value: string | string[] | { _id: string } | { _id: string }[],
  subtype: FieldSubtype
): Promise<string> {
  const result: string[] = []

  switch (subtype) {
    case FieldSubtype.USER:
      if (Array.isArray(value)) {
        result.push(...value.map(x => (typeof x === "string" ? x : x._id)))
      } else if (typeof value !== "string") {
        result.push(value._id)
      } else {
        result.push(...value.split(",").map((id: string) => id.trim()))
      }

      for (const id of result) {
        const user = await cache.user.getUser(id)
        if (!user) {
          throw new InvalidBBRefError(id, FieldSubtype.USER)
        }
      }
      break
    default:
      throw utils.unreachable(subtype)
  }

  return result.join(",")
}
