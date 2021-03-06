(function () {
  'use strict';

  describe('serviceStatus filter', function () {
    var serviceStatusFilter;

    beforeEach(module('console-app'));
    beforeEach(inject(function ($injector) {
      serviceStatusFilter = $injector.get('serviceStatusFilter');
    }));

    it('should return HTML markup for OK icon when status === `OK`', function () {
      var html = '<span class="material-icons app-icon-lg text-primary">check_circle</span>';
      expect(serviceStatusFilter('OK')).toBe(html);
    });

    it('should return HTML markup for DANGER icon when status === `ERROR`', function () {
      var html = '<span class="material-icons app-icon-lg text-danger">cancel</span>';
      expect(serviceStatusFilter('ERROR')).toBe(html);
    });

    it('should return HTML markup for UNKNOWN icon by default', function () {
      var html = '<span class="material-icons app-icon-lg ">help_outline</span>';
      expect(serviceStatusFilter('FOO')).toBe(html);
    });

    it('should return no HTML markup if status is undefined', function () {
      expect(serviceStatusFilter(undefined)).toBe('');
    });
  });

})();
