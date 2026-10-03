/** Small validator for exactly the self-contained design catalog's JSON Schema subset.
 * Unsupported validation keywords fail closed; no schema/network resolution or coercion. */
const supported=new Set(['type','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','minProperties','minimum','maximum','const','enum','oneOf','anyOf','allOf','pattern','format','title','description','default'])
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype)
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':plain(value)?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value)
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value
function formatted(value,format){
  if(format==='uuid')return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  if(format==='date')return date(value)
  if(format==='date-time')return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)&&date(value.slice(0,10))&&Number.isFinite(Date.parse(value))&&Number(value.slice(11,13))<24&&Number(value.slice(14,16))<60&&Number(value.slice(17,19))<60
  if(format==='uri'){try{return Boolean(new URL(value).protocol)}catch{return false}}
  return false
}
export function schemaMatches(schema,value,depth=0){
  if(depth>50||!plain(schema)||Object.keys(schema).some(key=>!supported.has(key)))return false
  if(value&&typeof value==='object'&&!Array.isArray(value)&&!plain(value))return false
  if(schema.oneOf&&schema.oneOf.filter(branch=>schemaMatches(branch,value,depth+1)).length!==1)return false
  if(schema.anyOf&&!schema.anyOf.some(branch=>schemaMatches(branch,value,depth+1)))return false
  if(schema.allOf&&!schema.allOf.every(branch=>schemaMatches(branch,value,depth+1)))return false
  if(Object.hasOwn(schema,'const')&&canonical(value)!==canonical(schema.const)||schema.enum&&!schema.enum.some(item=>canonical(item)===canonical(value)))return false
  const types=schema.type===undefined?null:Array.isArray(schema.type)?schema.type:[schema.type]
  const actual=value===null?'null':Array.isArray(value)?'array':plain(value)?'object':typeof value
  if(types&&!types.some(type=>type===actual||type==='integer'&&Number.isSafeInteger(value)))return false
  if(actual==='number'&&(!Number.isFinite(value)||schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum))return false
  if(actual==='string'){
    const length=Array.from(value).length
    if(schema.minLength!==undefined&&length<schema.minLength||schema.maxLength!==undefined&&length>schema.maxLength||schema.pattern&&!new RegExp(schema.pattern,'u').test(value)||schema.format&&!formatted(value,schema.format))return false
  }
  if(actual==='array'){
    if(value.length>10000||schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems||schema.uniqueItems&&new Set(value.map(canonical)).size!==value.length||schema.items&&!value.every(item=>schemaMatches(schema.items,item,depth+1)))return false
  }
  if(actual==='object'){
    const keys=Object.keys(value)
    if(keys.some(key=>['__proto__','prototype','constructor'].includes(key))||schema.minProperties!==undefined&&keys.length<schema.minProperties||schema.required?.some(key=>!Object.hasOwn(value,key)))return false
    for(const key of keys){if(Object.hasOwn(schema.properties??{},key)){if(!schemaMatches(schema.properties[key],value[key],depth+1))return false}else if(schema.additionalProperties===false)return false}
  }
  return actual!=='undefined'&&actual!=='function'&&actual!=='symbol'&&actual!=='bigint'
}
export function assertSchema(schema,value,code='TOOL_SCHEMA'){
  if(!schemaMatches(schema,value)){const error=Error(code);error.code=code;throw error}
}
