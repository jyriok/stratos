import { Injectable } from '@angular/core';
import { Actions, Effect } from '@ngrx/effects';
import { Store } from '@ngrx/store';

import { UtilsService, pathGet } from '../../core/utils.service';
import { EntityInlineParent, EntityRelationChild } from '../actions/action-types';
import { SetInitialParams } from '../actions/pagination.actions';
import { RequestTypes } from '../actions/request.actions';
import { AppState } from '../app-state';
import { pick } from '../helpers/reducer.helper';
import { WrapperRequestActionSuccess } from '../types/request.types';

@Injectable()
export class RequestEffect {
  constructor(
    private actions$: Actions,
    private store: Store<AppState>,
    private utils: UtilsService
  ) { }

  /**
   * Ensure all required inline parameters specified by the entity associated with the request exist.
   * If the inline parameter/s are..
   * - missing - dispatch an action to fetch them and ultimately store in a pagination. This will also populate the parent entities inline
   * parameter (see the generic request data reducer).
   * - exist - dispatch an action to store them in pagination.
   *
   * @memberof RequestEffect
   */
  @Effect() requestSuccess$ = this.actions$.ofType<WrapperRequestActionSuccess>(RequestTypes.SUCCESS)
    .mergeMap(action => {
      // Does the entity associated with the action have inline params that need to be validated?
      const entitySchema = pathGet('apiAction.entity', action) || {};
      const entityParent = (entitySchema.length > 0 ? entitySchema[0] : entitySchema) as EntityInlineParent;
      const childRelations = entityParent.childRelations;
      if (!childRelations || !childRelations.length) {
        return [];
      }

      // Do we have entities in the response to validate?
      const response = action.response;
      let entities = pathGet(`entities.${action.apiAction.entityKey}`, response) || {};
      entities = Object.values(entities);
      if (!entities || !entities.length) {
        return [];
      }

      // Confirm that all the required parameters exist in the response
      let actions = [];
      entities.forEach(entity => {
        // For each inline parameter required...
        childRelations.forEach(relation => {
          // Check to see if the inline parameter exists
          const childRelation = relation as EntityRelationChild;
          const paramAction = childRelation.createAction(entity);
          const paramValue = pathGet(childRelation.path, entity);
          if (paramValue) {
            // We've got the value already, ensure we create a pagination section for them
            const paramEntities = pick(response.entities[paramAction.entityKey], paramValue);
            const paginationSuccess = new WrapperRequestActionSuccess(
              {
                entities: {
                  [paramAction.entityKey]: paramEntities
                },
                result: paramValue
              },
              paramAction,
              'fetch',
              paramValue.length,
              1
            );
            actions.push(paginationSuccess);
          } else {
            // The values are missing, go fetch
            actions = [].concat(actions, [
              new SetInitialParams(paramAction.entityKey, paramAction.paginationKey, paramAction.initialParams, true),
              paramAction
            ]);
          }
        });
      });

      return actions;
    });

}