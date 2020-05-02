import cloneDeep from 'lodash/cloneDeep';
import get from 'lodash/get';
import invariant from 'invariant';
import lowerCase from 'lodash/lowerCase';
import memoize from 'lodash/memoize';
import omit from 'lodash/omit';
import upperFirst from 'lodash/upperFirst';
import { Bridge, joinName } from 'uniforms';

const resolveRef = (referance, schema) => {
  invariant(
    referance.startsWith('#'),
    'Reference is not an internal reference, and only such are allowed: "%s"',
    referance,
  );

  const resolvedReference = referance
    .split('/')
    .filter(part => part && part !== '#')
    .reduce((definition, next) => definition[next], schema);

  invariant(
    resolvedReference,
    'Reference not found in schema: "%s"',
    referance,
  );

  return resolvedReference;
};

const distinctSchema = schema => {
  if (schema.type === 'object') {
    return schema;
  }

  if (schema.$ref) {
    return { ...schema, ...resolveRef(schema.$ref, schema) };
  }

  return schema;
};

const extractValue = (...xs) =>
  xs.reduce((x, y) =>
    x === false || x === null ? '' : x !== true && x !== undefined ? x : y,
  );

const pathToName = path => {
  if (path[0] === '.')
    path = path
      .replace(/\['(.+?)'\]/g, '.$1')
      .replace(/\[(.+?)\]/g, '.$1')
      .replace(/\\'/g, "'");
  else path = path.replace(/\//g, '.').replace(/~0/g, '~').replace(/~1/g, '/');

  return path.slice(1);
};

const toHumanLabel = label => upperFirst(lowerCase(label));

export default class JSONSchemaBridge extends Bridge {
  schema: any;
  _compiledSchema: {};
  validator: any;

  constructor(schema, validator) {
    super();

    this.schema = distinctSchema(schema);
    this._compiledSchema = {};
    this.validator = validator;

    // Memoize for performance and referential equality.
    this.getField = memoize(this.getField);
    this.getSubfields = memoize(this.getSubfields);
    this.getType = memoize(this.getType);
  }

  static check() {
    return false;
  }

  getError(name, error) {
    const nameParts = joinName(null, name);
    const rootName = joinName(nameParts.slice(0, -1));
    const baseName = nameParts[nameParts.length - 1];

    return (
      error &&
      error.details &&
      error.details.find &&
      error.details.find(detail => {
        const path = pathToName(detail.dataPath);

        return (
          name === path ||
          (rootName === path && baseName === detail.params.missingProperty)
        );
      })
    );
  }

  getErrorMessage(name, error) {
    const scopedError = this.getError(name, error) || {};

    return (scopedError && scopedError.message) || '';
  }

  getErrorMessages(error) {
    if (error) {
      if (Array.isArray(error.details)) {
        return error.details.reduce(
          (acc, { message }) => acc.concat(message),
          [],
        );
      }

      return [error.message || error];
    }

    return [];
  }

  getField(name) {
    return joinName(null, name).reduce((definition, next, nextIndex, array) => {
      const previous = joinName(array.slice(0, nextIndex));
      const isRequired = get(
        definition,
        'required',
        get(this._compiledSchema, [previous, 'required'], []),
      ).includes(next);

      const _key = joinName(previous, next);
      const _definition = this._compiledSchema[_key] || {};

      if (next === '$' || next === '' + parseInt(next, 10)) {
        invariant(
          definition.type === 'array',
          'Field not found in schema: "%s"',
          name,
        );
        definition = Array.isArray(definition.items)
          ? definition.items[parseInt(next, 10)]
          : definition.items;
      } else if (definition.type === 'object') {
        invariant(
          definition.properties,
          'Field properties not found in schema: "%s"',
          name,
        );
        definition = definition.properties[next];
      } else {
        definition = ['allOf', 'anyOf', 'oneOf']
          .map(key =>
            get(definition, key, [])
              .map(definition => get(definition, ['properties', next]))
              .find(Boolean),
          )
          .find(Boolean);
      }

      invariant(definition, 'Field not found in schema: "%s"', name);

      if (definition.$ref) {
        definition = resolveRef(definition.$ref, this.schema);
      }

      ['allOf', 'anyOf', 'oneOf'].forEach(key => {
        if (definition[key]) {
          _definition[key] = definition[key].map(def =>
            def.$ref ? resolveRef(def.$ref, this.schema) : def,
          );
        }
      });

      // Naive computation of combined type, properties and required
      const combinedPartials: any[] = []
        .concat(_definition.allOf, _definition.anyOf, _definition.oneOf)
        .filter(Boolean);

      if (combinedPartials.length) {
        _definition.properties = {};
        _definition.required = [];

        combinedPartials.forEach(({ properties, required, type }) => {
          if (properties) Object.assign(_definition.properties, properties);
          if (required) _definition.required.push(...required);
          if (type && !_definition.type) _definition.type = type;
        });
      }

      this._compiledSchema[_key] = Object.assign(_definition, { isRequired });

      return definition;
    }, this.schema);
  }

  getInitialValue(name, props: any = {}) {
    const { default: _default, type: _type } = this.getField(name);
    const {
      default: defaultValue = _default !== undefined
        ? _default
        : get(this.schema.default, name),
      type = _type,
    } = this._compiledSchema[name];

    if (defaultValue !== undefined) return cloneDeep(defaultValue);

    if (type === 'array') {
      const item = this.getInitialValue(joinName(name, '0'));
      const items = props.initialCount || 0;
      return Array(items).fill(item);
    }

    if (type === 'object') return {};

    return undefined;
  }

  getProps(name, props: any = {}) {
    const { uniforms, ...field } = this.getField(name);
    const { enum: enum_, isRequired, title, ...ready } = omit(
      { ...field, ...uniforms, ...this._compiledSchema[name] },
      ['default', 'format', 'type'],
    );

    if (enum_) ready.allowedValues = enum_;
    if (field.type === 'number') ready.decimal = true;
    if (uniforms && uniforms.type !== undefined) ready.type = uniforms.type;
    if (ready.required === undefined) ready.required = isRequired;
    ready.label = extractValue(
      ready.label,
      title,
      toHumanLabel(joinName(null, name).slice(-1)[0]),
    );

    const options = props.options || ready.options;
    if (options) {
      if (!Array.isArray(options)) {
        ready.transform = value => options[value];
        ready.allowedValues = Object.keys(options);
      } else {
        ready.transform = value =>
          options.find(option => option.value === value).label;
        ready.allowedValues = options.map(option => option.value);
      }
    }

    return ready;
  }

  getSubfields(name) {
    if (!name) {
      if (this.schema.properties) {
        return Object.keys(this.schema.properties);
      }

      return [];
    }

    const { type: _type, properties: _properties } = this.getField(name);
    const {
      type: fieldType = _type,
      properties: fieldProperties = _properties,
    } = this._compiledSchema[name];

    if (fieldType === 'object') {
      return Object.keys(fieldProperties);
    }

    return [];
  }

  getType(name) {
    const { type: _type, format: fieldFormat } = this.getField(name);
    const { type: fieldType = _type } = this._compiledSchema[name];

    if (fieldFormat === 'date-time') return Date;
    if (fieldType === 'string') return String;
    if (fieldType === 'number') return Number;
    if (fieldType === 'integer') return Number;
    if (fieldType === 'object') return Object;
    if (fieldType === 'array') return Array;
    if (fieldType === 'boolean') return Boolean;

    invariant(
      fieldType !== 'null',
      'Field "%s" can not be represented as a type null',
      name,
    );

    return fieldType;
  }

  getValidator() {
    return this.validator;
  }
}
