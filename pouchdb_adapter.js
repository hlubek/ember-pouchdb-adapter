(function() {
  var get = Ember.get, set = Ember.set;

  DS.PouchDBSerializer = DS.FixtureSerializer.extend({

    /**
     * Override to get the document revision that is stored on the record for PouchDB updates
     */
    addAttributes: function(data, record) {
      this._super(data, record);
      data._rev = get(record, '_rev');
    },

    addBelongsTo: function(data, record, key, relationship) {
      data[relationship.key] = get(get(record, key), 'id');
    },

    addHasMany: function(data, record, key, relationship) {
      var ids = [];
      get(record, relationship.key).forEach(function(item) {
        ids.push(get(item, 'id'));
      });

      data[relationship.key] = ids;
    },

    addId: function(data, key, id) {
      data[key] = id;
      data._id = id;
    },

    addType: function(data, type) {
      data['emberDataType'] = type.toString();
    },

    /**
     * Add the document revision to the record on materialization
     *
     * TODO Check if this is a good idea or a special Document mixin should be used
     * that defines an attribute that will do just this.
     */
    materializeAttributes: function(record, serialized, prematerialized) {
      this._super(record, serialized, prematerialized);
      set(record, '_rev', serialized._rev);
    }
  });

  /**
   * Based on https://github.com/panayi/ember-data-indexeddb-adapter and https://github.com/wycats/indexeddb-experiment
   *
   */
  DS.PouchDBAdapter = DS.Adapter.extend({
    serializer: DS.PouchDBSerializer,

    /**
     Hook used by the store to generate client-side IDs. This simplifies
     the timing of committed related records, so it's preferable.

     For this adapter, we use uuid.js by Rober Kieffer, which generates
     UUIDs using the best-available random number generator.

     @returns {String} a UUID
     */
    generateIdForRecord: function() {
      return uuid();
    },

    /**
     Main hook for saving a newly created record.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} records
     */
    createRecord: function(store, type, record) {
      var self = this,
          hash = this.serialize(record, { includeId: true, includeType: true });

      this._getDb().put(hash, function(err, response) {
        if (!err) {
          set(record, '_rev', response.rev);
          self.didCreateRecord(store, type, record);
        } else {
          console.error(err);
        }
      });
    },

    /**
     Main hook for updating an existing record.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} record
     */
    updateRecord: function(store, type, record) {
      var self = this,
          hash = this.serialize(record, { includeId: true, includeType: true });

      // Store the type in the value so that we can index it on read
      hash['emberDataType'] = type.toString();

      this._getDb().put(hash, function(err, response) {
        if (!err) {
          set(record, '_rev', response.rev);
          self.didUpdateRecord(store, type, record);
        } else {
          console.error(err);
        }
      });
    },

    deleteRecord: function(store, type, record) {
      var self = this;

      this._getDb().remove({
        _id: get(record, 'id'),
        _rev: get(record, '_rev')
      }, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          set(record, '_rev', response.rev);
          self.didDeleteRecord(store, type, record);
        }
      });
    },

    find: function(store, type, id) {
      this.findMany(store, type, [id]);
    },

    findMany: function(store, type, ids) {
      var self = this,
          db = this._getDb(),
          data = [];

      db.allDocs({keys: ids, include_docs: true}, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          if (response.rows) {
            response.rows.forEach(function(row) {
              data.push(row.doc);
            });
            self.didFindMany(store, type, data);
          }
        }
      });
    },

    findAll: function(store, type, sinceToken) {
      var self = this,
          db = this._getDb(),
          data = [];

      db.query({map: function(doc) {
        if (doc['emberDataType']) {
          emit(doc['emberDataType'], null);
        }
      }}, {reduce: false, key: type.toString(), include_docs: true}, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          if (response.rows) {
            response.rows.forEach(function(row) {
              data.push(row.doc);
            });
            self.didFindAll(store, type, data);
          }
        }
      });
    },

    findQuery: function(store, type, query, array) {
      var self = this,
          db = this._getDb();

      var keys = [];
      for (key in query) {
        if (query.hasOwnProperty(key)) {
          keys.push(key);
        }
      }

      var emitKeys = keys.map(function(key) {
        return 'doc.' + key;
      });
      var queryKeys = keys.map(function(key) {
        return query[key];
      });

      // Very simple map function for a conjunction (AND) of all keys in the query
      var mapFn = 'function(doc) {' +
            'if (doc["emberDataType"]) {' +
              'emit([doc["emberDataType"]' + (emitKeys.length > 0 ? ',' : '') + emitKeys.join(',') + '], null);' +
            '}' +
          '}';

      db.query({map: mapFn}, {reduce: false, key: [].concat(type.toString(), queryKeys), include_docs: true}, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          if (response.rows) {
            var data = response.rows.map(function(row) { return row.doc; });
            self.didFindQuery(store, type, data, array);
          }
        }
      });
    },

    // private

    /**
     * Lazily create a PouchDB instance
     *
     * @returns {PouchDB}
     * @private
     */
    _getDb: function() {
      if (!this.db) {
        this.db = new PouchDB(this.databaseName || 'ember-application-db');
      }
      return this.db;
    }

  });
})();
