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

    toJSON: function(record, options) {
      return get(this, 'serializer').toJSON(record, options);
    },

    /**
     Main hook for saving a newly created record.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} records
     */
    createRecord: function(store, type, record) {
      var hash = this.serialize(record, { includeId: true, includeType: true });

      this._getDb().put(hash, function(err, response) {
        if (!err) {
          set(record, '_rev', response.rev);
          store.didSaveRecord(record);
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
      var hash = this.serialize(record, { includeId: true, includeType: true });

      // Store the type in the value so that we can index it on read
      hash['emberDataType'] = type.toString();

      this._getDb().put(hash, function(err, response) {
        if (!err) {
          store.didSaveRecord(record);
        } else {
          console.error(err);
        }
      });
    },

    /**
     Main hook for deleting an existing record. Note that
     deletions can also trigger changes in relationships with
     other records.

     If those records are unloaded, those changes happen
     through the update*Relationship family of methods.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} record
     */
    deleteRecord: function(store, type, record) {
      var self = this;
      this.attemptDbTransaction(store, record, function(dbStore) {
        return dbStore['delete'](self.dbId(record));
      });
    },

    /**
     The main hook for finding a single record. The `findMany`
     hook defaults to delegating to this method.

     Since the IndexedDB database is local, we don't need to
     implement a specific `findMany` method.

     @param {DS.Store} store
     @param {Class} type
     @param {String|Number} id
     */
    find: function(store, type, id) {
      var self = this,
          db = this._getDb();

      db.query({map: function(doc) {
        if (doc['emberDataType']) {
          emit(doc['emberDataType'], null);
        }
      }}, {reduce: false, key: type.toString(), include_docs: true}, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          if (response.rows && response.rows[0]) {
            self.didFindRecord(store, type, response.rows[0].doc, id)
          }
        }
      });
    },

    findMany: function(store, type, ids) {
      var self = this,
          db = this._getDb(),
          records = Ember.A();

      db.allDocs({keys: ids, include_docs: true}, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          if (response.rows) {
            response.rows.forEach(function(row) {
              records.pushObject(row.doc);
            });
            self.didFindMany(store, type, records);
          }
        }
      });
    },

    findAll: function(store, type, sinceToken) {
      var self = this,
          db = this._getDb(),
          data = [];

      db.allDocs({include_docs: true}, function(err, response) {
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

    /**
     Using a cursor that loops through *all* results, comparing each one against the query.
     TODO: For performance reasons we should use indexes on query attributes.
     (https://developer.mozilla.org/en-US/docs/IndexedDB/Using_IndexedDB#Using_an_index)

     @param {DS.Store} store
     @param {Class} type
     @param {Object} query
     @param {Array} array
     */
    findQuery: function(store, type, query, array) {
      var match = function(hash, query) {
        result = true;
        for (var key in query) {
          if (query.hasOwnProperty(key)) {
            result = result && (hash[key] === query[key]);
          }
        }
        return result;
      };

      var cursor, records = [], self = this;
      var onSuccess = function(event) {
        if (cursor = event.target.result) {
          if (match(cursor.value, query)) {
            records.pushObject(cursor.value);
          }
          cursor.continue();
        } else {
          self.didFindQuery(store, type, array, records);
        }
      };

      this.read(store, type, onSuccess);
    },

    didFindQuery: function(store, type, array, records) {
      array.load(records);
    },

    // private

    _getDatabaseName: function() {
      return this.databaseName || 'ember-application-db';
    },

    _getDb: function() {
      if (!this.db) {
        this.db = new PouchDB(this._getDatabaseName());
      }
      return this.db;
    }

  });
})();
